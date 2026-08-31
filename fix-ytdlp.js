/**
 * yt-dlp 自愈脚本
 * ---------------------------------------------------------------
 * 背景：yt-dlp.exe 有两种形态
 *   1) 官方独立版  —— 约 17~20MB，开箱即用（我们要的）
 *   2) pip 安装残留的"启动器桩" —— 只有 ~108KB，运行时会去找 Python 里的
 *      yt_dlp 模块。若本机 Python 没装这个模块，就会报：
 *         ModuleNotFoundError: No module named 'yt_dlp'
 *
 * 本脚本做的事：
 *   1. 检查同目录 yt-dlp.exe 是不是"桩"（小于 1MB）或缺失
 *   2. 走代理（默认 127.0.0.1:7897，失败则直连）从 GitHub Release 下载官方独立版
 *   3. 下载到临时文件 → 校验大小 → 跑一次 --version → 原子替换
 *
 * 用法：node fix-ytdlp.js [--force]
 *   --force  即使当前 yt-dlp 看起来正常，也强制重新拉取最新版
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { spawnSync } = require('child_process');

const BASE = __dirname;
const EXE = path.join(BASE, 'yt-dlp.exe');
const TMP = path.join(BASE, 'yt-dlp.exe.downloading');
const STATUS = path.join(BASE, '.ytdlp-fix.status');
const MIN_SIZE = 1 * 1024 * 1024; // 小于 1MB 一律视为 pip 启动器桩
const PROXY = process.env.FIX_YTDLP_PROXY || 'http://127.0.0.1:7897';

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  try { process.stdout.write(line + '\n'); } catch (e) {}
  try { fs.appendFileSync(path.join(BASE, '_fix-ytdlp.log'), line + '\n'); } catch (e) {}
}
function setStatus(obj) {
  try { fs.writeFileSync(STATUS, JSON.stringify(Object.assign({ ts: Date.now() }, obj))); } catch (e) {}
}

// ---------- 通过 HTTP 代理建立 CONNECT 隧道 ----------
function tunnel(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: 15000
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error('代理 CONNECT 返回 ' + res.statusCode));
      }
      resolve(socket);
    });
    req.once('timeout', () => { req.destroy(new Error('代理连接超时')); });
    req.once('error', reject);
    req.end();
  });
}

// ---------- 带重定向跟随的 HTTPS GET（可选择走代理） ----------
async function httpsGet(urlStr, useProxy, redirects = 0) {
  if (redirects > 6) throw new Error('重定向次数过多');
  const u = new URL(urlStr);
  const isTls = u.protocol === 'https:';
  const port = Number(u.port) || (isTls ? 443 : 80);
  let sock;

  if (useProxy) {
    sock = await tunnel(PROXY, u.hostname, port);
  }

  return new Promise((resolve, reject) => {
    const opts = {
      method: 'GET',
      host: u.hostname,
      path: u.pathname + u.search,
      headers: { Host: u.hostname, 'User-Agent': 'autosub-video-downloader', Accept: '*/*' },
      timeout: 30000
    };
    if (sock) {
      // 隧道已建立，在其之上再叠一层 TLS
      opts.createConnection = () => tls.connect({ socket: sock, servername: u.hostname });
    }
    const mod = isTls ? https : http;
    const req = mod.request(opts, (res) => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        let next = res.headers.location;
        if (next.startsWith('/')) next = `https://${u.hostname}${next}`;
        return httpsGet(next, useProxy, redirects + 1).then(resolve, reject);
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
      resolve(res);
    });
    req.once('timeout', () => req.destroy(new Error('请求超时')));
    req.once('error', reject);
    req.end();
  });
}

// 顺序尝试：代理优先，失败则直连
async function tryGet(urlStr) {
  try {
    return await httpsGet(urlStr, true);
  } catch (e1) {
    log(`  走代理失败（${e1.message}），尝试直连…`);
    return await httpsGet(urlStr, false);
  }
}

// ---------- 查询最新版本号 ----------
async function latestVersion() {
  // 先用 API 拿，拿不到再从 302 跳转里抠 tag
  try {
    const res = await tryGet('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
    const body = await collect(res);
    const j = JSON.parse(body);
    if (j && j.tag_name) return j.tag_name;
  } catch (e) { /* 继续走兜底 */ }

  const res = await tryGet('https://github.com/yt-dlp/yt-dlp/releases/latest');
  res.resume();
  // 走到这里说明没发生重定向（异常），用固定兜底版本
  return null;
}

function collect(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.once('error', reject);
  });
}

// ---------- 下载到文件 ----------
function downloadToFile(res, dest) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    let bytes = 0;
    let lastReport = 0;
    res.on('data', (c) => {
      bytes += c.length;
      if (bytes - lastReport > 4 * 1024 * 1024) {
        lastReport = bytes;
        log(`  已下载 ${(bytes / 1048576).toFixed(1)} MB`);
      }
    });
    res.once('error', reject);
    ws.once('error', reject);
    ws.once('finish', () => resolve(bytes));
    res.pipe(ws);
  });
}

// 候选下载地址（GitHub 主源 + 镜像兜底）
function candidates(tag) {
  const list = [];
  if (tag) {
    list.push(`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp.exe`);
    list.push(`https://ghfast.top/https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp.exe`);
  }
  list.push('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
  return list;
}

(async function main() {
  const force = process.argv.includes('--force');

  if (!force) {
    let size = 0;
    try { size = fs.statSync(EXE).size; } catch (e) { size = 0; }
    if (size >= MIN_SIZE) {
      log(`yt-dlp.exe 已是完整独立版（${(size / 1048576).toFixed(1)} MB），无需修复。`);
      setStatus({ ok: true, skipped: true, size });
      return;
    }
    log(size === 0 ? '未发现 yt-dlp.exe，开始下载…'
                   : `发现 pip 启动器桩（${size} 字节），开始下载官方独立版…`);
  } else {
    log('强制模式：重新拉取最新版…');
  }

  let tag = null;
  try {
    tag = await latestVersion();
    log(`最新版本：${tag || '(未知，使用 latest 通道)'}`);
  } catch (e) {
    log(`获取版本号失败：${e.message}`);
  }

  let ok = false;
  for (const url of candidates(tag)) {
    const host = new URL(url).hostname;
    try {
      log(`尝试从 ${host} 下载…`);
      const res = await tryGet(url);
      const bytes = await downloadToFile(res, TMP);
      if (bytes < MIN_SIZE) {
        log(`  文件过小（${bytes} 字节），判定失败，换下一个源`);
        continue;
      }
      log(`  下载完成：${(bytes / 1048576).toFixed(1)} MB`);
      ok = true;
      break;
    } catch (e) {
      log(`  失败：${e.message}`);
    }
  }

  if (!ok) {
    log('所有下载源均失败。请检查网络/代理（默认 7897）后重试：node fix-ytdlp.js');
    setStatus({ ok: false, error: 'all sources failed' });
    process.exit(1);
  }

  // 校验：能跑出版本号才算数
  try { fs.chmodSync(TMP, 0o755); } catch (e) {}
  const r = spawnSync(TMP, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const ver = (r.stdout || '').trim().split(/\r?\n/).pop();
  if (r.status !== 0 || !/^\d{4}\./.test(ver)) {
    log(`校验失败（退出码 ${r.status}，输出：${ver || r.stderr}），保留原文件不动。`);
    try { fs.unlinkSync(TMP); } catch (e) {}
    setStatus({ ok: false, error: 'version check failed' });
    process.exit(1);
  }

  // 原子替换：先备份旧文件，再换上新的
  try {
    if (fs.existsSync(EXE)) {
      try { fs.unlinkSync(EXE + '.old'); } catch (e) {}
      try { fs.renameSync(EXE, EXE + '.old'); } catch (e) {}
    }
    fs.renameSync(TMP, EXE);
  } catch (e) {
    log(`替换文件失败：${e.message}（可能需要先关闭占用它的程序）`);
    setStatus({ ok: false, error: 'replace failed: ' + e.message });
    process.exit(1);
  }

  log(`修复完成：yt-dlp ${ver}（${(fs.statSync(EXE).size / 1048576).toFixed(1)} MB）`);
  setStatus({ ok: true, version: ver, size: fs.statSync(EXE).size });
})().catch((e) => {
  log('未预期错误：' + (e && e.stack || e));
  setStatus({ ok: false, error: String(e && e.message || e) });
  process.exit(1);
});
