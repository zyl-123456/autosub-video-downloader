/**
 * yt-dlp 本地下载服务
 * 作用：在网页和本机 yt-dlp.exe 之间搭桥
 *  - 接收前端 POST 的链接列表
 *  - 为每条链接启动一个 yt-dlp 进程（走 7897 代理 + 同目录 ffmpeg 合并）
 *  - 解析 yt-dlp 的进度输出（百分比 / 速度 / ETA），通过 SSE 实时推回前端
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 8731;
const BASE = __dirname;                       // D:\000-me-work\video-downloading
const YTDL = path.join(BASE, 'yt-dlp.exe');
const FFMPEG = path.join(BASE, 'ffmpeg', 'bin');
const PROXY = 'http://127.0.0.1:7897';
const OUT_DIR = path.join(BASE, 'downloaded videos');  // 媒体库：视频统一存这里
const THUMB_DIR = path.join(OUT_DIR, '.thumbs');       // 封面缩略图缓存
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

// yt-dlp 自愈：pip 会在同目录留下 ~108KB 的"启动器桩"exe，
// 它运行时才去找 Python 里的 yt_dlp 模块，找不到就抛
//   ModuleNotFoundError: No module named 'yt_dlp'
// 官方独立版约 17MB+，开箱即用。这里做体检 + 自动下载替换。
const FIX_SCRIPT = path.join(BASE, 'fix-ytdlp.js');
const YTDL_MIN_SIZE = 1024 * 1024;   // 小于 1MB 一律判定为启动器桩
const ytdlpHealth = { ok: true, checking: false, message: '' };

// 可选配置：读项目目录 config.json（没有就用默认值）
const CFG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(BASE, 'config.json'), 'utf8')); }
  catch (e) { return {}; }
})();
// 下载完成后是否"自动"离线转写。默认关闭——whisper large-v3 很吃 CPU/GPU，
// 会让电脑卡顿；需要字幕时建议在前端点"🎙 生成字幕"手动触发，或在 config.json
// 里设 "autoTranscribe": true 开启自动转写（仍会跳过已有中文字幕的视频）
const AUTO_TRANSCRIBE = CFG.autoTranscribe === true;

// 简易任务表：id -> {url, proc, status, percent, ...}
const tasks = new Map();
let taskSeq = 0;

// 持久化任务日志：服务重启也能找回已完成任务的 filename，
// 避免点"打开/文件夹"报"task not done or no file"
const taskLogPath = path.join(BASE, '.task-log.json');
let persistedTasks = (() => {
  try {
    const arr = JSON.parse(fs.readFileSync(taskLogPath, 'utf8'));
    return new Map(arr.map(t => [t.id, t]));
  } catch (e) { return new Map(); }
})();

function saveTaskState(task) {
  persistedTasks.set(task.id, {
    id: task.id, url: task.url,
    filename: task.filename || '',
    status: task.status,
    savedAt: new Date().toISOString()
  });
  // 只保留最近 100 条，防止日志无限膨胀
  const arr = [...persistedTasks.values()].slice(-100);
  try { fs.writeFileSync(taskLogPath, JSON.stringify(arr, null, 2)); } catch (e) {}
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// 解析 yt-dlp 进度行，例如：
// [download]  45.2% of   12.34MiB at  500KiB/s ETA 00:05
function parseProgress(line) {
  const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+([^\s]+)\s+at\s+([^\s]+)\s+ETA\s+([\d:]+)/);
  if (m) {
    return { percent: parseFloat(m[1]), size: m[2], speed: m[3], eta: m[4] };
  }
  // 部分格式没有 ETA 或速度
  const m2 = line.match(/\[download\]\s+([\d.]+)%\s+of\s+([^\s]+)/);
  if (m2) {
    return { percent: parseFloat(m2[1]), size: m2[2], speed: '', eta: '' };
  }
  return null;
}

// Cookie 池：目录里任何名字的 cookies*.txt 都会被自动合并成运行时库，
// yt-dlp 按域名自动匹配（Netscape 格式每行带域名字段，多域名互不干扰）。
// 新站点 = 浏览器导出 cookie 文件丢进本目录，零配置零改代码。
const COOKIE_GLOB_RE = /^cookies.*\.txt$/i;
function buildCookiePool() {
  let names = [];
  try { names = fs.readdirSync(BASE); } catch (e) {}
  const files = names.filter(n => COOKIE_GLOB_RE.test(n) && n !== '.task-log.json');
  if (!files.length) return null;
  // 合并所有 cookie 文件为一个临时库（跳过注释与表头，保留每个文件的域名字段）
  const merged = [];
  for (const name of files) {
    try {
      const lines = fs.readFileSync(path.join(BASE, name), 'utf8')
        .split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
      merged.push(...lines);
    } catch (e) { /* 单个文件读失败跳过 */ }
  }
  if (!merged.length) return null;
  const pool = path.join(BASE, '.cookie-pool.txt');
  try {
    fs.writeFileSync(pool, '# Netscape HTTP Cookie File (merged pool)\n' + merged.join('\n') + '\n');
    return pool;
  } catch (e) { return null; }
}

// ---------- yt-dlp 体检与自愈 ----------
function refreshYtdlpHealth() {
  let size = 0;
  try { size = fs.statSync(YTDL).size; } catch (e) { size = 0; }
  ytdlpHealth.ok = size >= YTDL_MIN_SIZE;
  ytdlpHealth.message = ytdlpHealth.ok ? '' : (size === 0
    ? '未找到 yt-dlp.exe，正在自动下载官方独立版（约 17MB）…'
    : `yt-dlp.exe 是 pip 启动器桩（仅 ${size} 字节，无法独立运行），正在自动下载官方独立版（约 17MB）…`);
  return ytdlpHealth.ok;
}

function repairYtdlp() {
  if (ytdlpHealth.checking || !fs.existsSync(FIX_SCRIPT)) return;
  ytdlpHealth.checking = true;
  console.log('[yt-dlp] ' + ytdlpHealth.message);
  const p = spawn(process.execPath, [FIX_SCRIPT], {
    cwd: BASE, windowsHide: true, stdio: 'ignore', detached: true
  });
  p.on('error', () => { ytdlpHealth.checking = false; });
  p.on('exit', () => {
    ytdlpHealth.checking = false;
    if (refreshYtdlpHealth()) console.log('[yt-dlp] 自愈完成，可以正常下载了。');
    else console.warn('[yt-dlp] 自动修复未完成，请检查网络/代理（默认 127.0.0.1:7897）。');
  });
  p.unref();
}

function ensureYtdlp() {
  if (refreshYtdlpHealth()) return true;
  repairYtdlp();
  return false;
}

// ---------------------------------------------------------------------------
// yt-dlp 输出解码
// 痛点：yt-dlp 在 Windows 上即便设了 PYTHONUTF8=1，偶发仍按系统编码(GBK)输出；
//       直接 buf.toString('utf8') 会把 GBK 字节当 UTF-8 解，中文变 Ϊʲô 之类乱码。
//       另外 data 事件可能把一个多字节字符切到两个 chunk，逐 chunk 解码会丢字符。
// 方案：缓存原始字节，按 \r/\n 切出完整行（这两个是 ASCII，不会落在多字节字符中间），
//       每行先按 UTF-8 解；若没解出中文、但字节里有高位字节，就按 GBK 重解——
//       GBK 解出中文说明原是 GBK 编码，用它替换。（不靠脆弱的乱码字符范围正则）
// ---------------------------------------------------------------------------
const _utf8Dec = new TextDecoder('utf-8', { fatal: false });
const _gbkDec = new TextDecoder('gbk', { fatal: false });
function decodeYtdlpLine(bytes) {
  const u = _utf8Dec.decode(bytes);
  if (/[\u4e00-\u9fff]/.test(u)) return u;            // UTF-8 已解出中文，正常
  // UTF-8 没解出中文，却出现 3+ 个连续非 ASCII 字符（0080-04FF）→ 典型的
  // "GBK 中文被当 UTF-8 误读"特征（如 为什么→Ϊʲô）。合法重音词（café）只有零星
  // 单个高位字符，凑不出连续 3 个，不会误触发。此时按 GBK 重解，解出中文即采用。
  if (/[\u0080-\u04ff]{3,}/.test(u)) {
    try { const g = _gbkDec.decode(bytes); if (/[\u4e00-\u9fff]/.test(g)) return g; } catch (e) {}
  }
  return u;
}

function startDownload(task) {
  // 体检：yt-dlp 缺失或只是启动器桩时先自愈，别把晦涩的 Python 报错甩给用户
  if (!refreshYtdlpHealth()) {
    task.status = 'error';
    task.percent = 0;
    task.lastError = ytdlpHealth.message + ' 稍等约半分钟后重试本条链接即可。';
    saveTaskState(task);
    repairYtdlp();
    return;
  }

  const args = [
    '--proxy', PROXY,
    '--ffmpeg-location', FFMPEG,
    '-P', OUT_DIR,
    '-o', '%(title)s/%(title)s [%(id)s].%(ext)s',   // 每条视频自动建同名文件夹，视频+字幕都存里面
    '--newline',
    '--no-playlist',          // 单条链接默认不下整个列表，避免误下整集
    '--js-runtimes', 'node',  // YouTube 签名挑战需要 JS 运行时（node.exe 已放本目录）
    // 字幕：优先真人上传的简体中文字幕；ai-zh 是 B 站的 AI 字幕语言代码
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', 'zh-Hans,zh-CN,zh-Hans-zh,ai-zh',
    '--convert-subs', 'srt',
    '--embed-subs',
  ];

  // Cookie 池：目录里所有 cookies*.txt 自动合并，按域名生效；
  // 池为空时才尝试读浏览器（需浏览器未运行）。
  const cookiePool = buildCookiePool();
  if (cookiePool) {
    args.push('--cookies', cookiePool);
  } else {
    const chromeCookies = 'C:\\Users\\joe\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies';
    const edgeCookies   = 'C:\\Users\\joe\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cookies';
    if (fs.existsSync(chromeCookies)) {
      args.push('--cookies-from-browser', 'chrome');
    } else if (fs.existsSync(edgeCookies)) {
      args.push('--cookies-from-browser', 'edge');
    }
  }

  args.push(task.url);

  task.status = 'downloading';
  task.percent = 0;
  task.log = [];

  // PYTHONUTF8=1 强制 yt-dlp(Python) 用 UTF-8 输出，避免 Windows 管道下中文标题变 GBK 乱码
  const env = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(YTDL, args, { cwd: BASE, windowsHide: true, env });
  task.proc = proc;

  // 处理一行 yt-dlp 输出：解析进度 / 文件名 / 合并 / 错误
  function handleLine(line) {
    const p = parseProgress(line);
    if (p) {
      task.percent = p.percent;
      task.size = p.size;
      task.speed = p.speed;
      task.eta = p.eta;
      broadcast(task);
    } else if (line.includes('[download] Destination:')) {
      task.filename = line.split('Destination:')[1].trim();
      saveTaskState(task);
      broadcast(task);
    } else if (line.includes('[Merger]') || line.includes('Merging')) {
      // [Merger] Merging formats into "最终文件.mp4" —— 用合并后的成品文件名替换下载中的临时名
      const m = line.match(/Merging formats into "(.+?)"/);
      if (m) task.filename = m[1];
      task.merging = true;
      saveTaskState(task);
      broadcast(task);
    } else if (line.toLowerCase().includes('error') || line.includes('ERROR')) {
      task.lastError = line.trim();
      saveTaskState(task);
      broadcast(task);
    }
  }

  // 缓存原始字节、按 \r/\n 切完整行再解码，避免 chunk 把多字节字符切开 + 兼容 GBK 输出
  let rawBuf = Buffer.alloc(0);
  const onData = (buf) => {
    rawBuf = Buffer.concat([rawBuf, buf]);
    let start = 0;
    const lines = [];
    for (let i = 0; i < rawBuf.length; i++) {
      const b = rawBuf[i];
      if (b === 0x0A || b === 0x0D) {
        if (i > start) lines.push(rawBuf.slice(start, i));
        start = i + 1;
        if (b === 0x0D && rawBuf[i + 1] === 0x0A) { i++; start = i + 1; }
      }
    }
    rawBuf = rawBuf.slice(start);   // 保留最后一段未结束的片段
    for (const lb of lines) {
      const line = decodeYtdlpLine(lb);
      if (!line) continue;
      task.log.push(line);
      if (task.log.length > 200) task.log.shift();
      handleLine(line);
    }
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code) => {
    // 收尾：冲刷残留字节
    if (rawBuf.length) {
      const line = decodeYtdlpLine(rawBuf);
      rawBuf = Buffer.alloc(0);
      if (line) { task.log.push(line); handleLine(line); }
    }
    task.proc = null;
    if (code === 0) {
      task.status = 'done';
      task.percent = 100;
      // 安全网：如果 [Merger]/[Destination] 行因输出缓冲没被捕获到，
      // 就拿输出目录下最近改动的视频文件顶上，免得点打开按钮报"无文件"
      if (!task.filename) {
        task.filename = findLatestVideo();
      }
      // 用 URL 里的视频 ID 在目录里精确定位本次下载的视频（不依赖 task.filename，
      // 因为重下载已有视频时 filename 可能落到 .vtt 字幕文件上）
      const vp = resolveVideoByTask(task);
      // 预算 hasSub，让前端 UI 准确（有中文字幕就不再显示"生成字幕"按钮）
      task.hasSub = vp ? hasChineseSubForFile(vp) : false;
      saveTaskState(task);
      broadcast(task);
      // 自动字幕：仅在开启 AUTO_TRANSCRIBE 且确实没有中文字幕时才触发离线转写
      // （默认关闭：whisper large-v3 很吃资源会卡电脑；需要时手动点"🎙 生成字幕"即可）
      if (vp && AUTO_TRANSCRIBE && !task.hasSub && !task.startedAutoSub) {
        task.startedAutoSub = true;
        const subTask = {
          id: ++taskSeq, url: task.url, filename: vp,
          status: 'queued', percent: 0, log: []
        };
        tasks.set(subTask.id, subTask);
        saveTaskState(subTask);
        broadcast(subTask);
        startTranscribe(subTask);
      }
    } else {
      task.status = 'error';
      if (!task.lastError) task.lastError = `进程退出码 ${code}`;
      saveTaskState(task);
      broadcast(task);
    }
  });
}

// ---------------------------------------------------------------------------
// 离线语音转文字（复用 listen 项目的 conda 环境 + large-v3 模型）
// 把视频/音频的语音转成简体中文字幕(SRT)，落进同名文件夹
// ---------------------------------------------------------------------------
const LISTEN_PY = 'C:\\Users\\joe\\.conda\\envs\\listen\\python.exe';
const TRANSCRIBE_SCRIPT = path.join(BASE, 'transcribe_video.py');

// 根据已完成任务的 filename 找到对应的视频文件绝对路径
function resolveVideoFile(task) {
  if (!task || !task.filename) return null;
  const p = path.resolve(BASE, task.filename);
  if (fs.existsSync(p) && /\.(webm|mp4|mkv|flv|mov|m4v|avi)$/i.test(p)) return p;
  return null;
}

// 从任务找视频文件：优先按 URL 里的 11 位视频 ID 在目录里精确查找本次下载的视频
// （不依赖 task.filename，因为下载完成时安全网可能误指其他视频）；filename 仅作后备
function resolveVideoByTask(task) {
  if (task && task.url) {
    const m = task.url.match(/([A-Za-z0-9_-]{11})/);
    if (m) {
      const id = m[1];
      const exts = ['.webm', '.mp4', '.mkv', '.flv', '.mov', '.m4v', '.avi'];
      let found = null;
      const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (e) { return; }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          try {
            if (e.isDirectory()) { walk(p); continue; }
            if (!exts.some(x => e.name.toLowerCase().endsWith(x))) continue;
            if (e.name.includes('[' + id + ']')) { found = p; return; }
          } catch (e) { /* ignore */ }
        }
      };
      walk(OUT_DIR);
      if (found) return found;
    }
  }
  return resolveVideoFile(task);
}

function startTranscribe(task) {
  const videoPath = resolveVideoFile(task);
  if (!videoPath) {
    task.status = 'error';
    task.lastError = '找不到对应的视频文件，无法生成字幕';
    saveTaskState(task);
    broadcast(task);
    return;
  }
  const existingSub = findChineseSubForFile(videoPath);
  if (existingSub) {
    // 已有中文字幕（YouTube 自带 zh-Hans-zh 等），无需再转写
    task.status = 'done';
    task.percent = 100;
    task.filename = videoPath;
    task.subtitle = existingSub;
    saveTaskState(task);
    broadcast(task);
    return;
  }

  task.status = 'transcribing';
  task.percent = 0;
  task.kind = 'transcribe';     // 标记任务类型，前端据此显示不同文案
  task.log = [];

  const env = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  let proc;
  try {
    proc = spawn(LISTEN_PY, [TRANSCRIBE_SCRIPT, videoPath], {
      cwd: BASE, windowsHide: true, env
    });
  } catch (e) {
    task.status = 'error';
    task.lastError = '启动转写进程失败：' + e.message;
    saveTaskState(task);
    broadcast(task);
    return;
  }
  // spawn 异步错误（如解释器路径不存在）兜底，避免单个任务拖垮整个服务
  proc.on('error', (e) => {
    task.status = 'error';
    task.lastError = '转写进程错误：' + e.message;
    saveTaskState(task);
    broadcast(task);
  });
  task.proc = proc;

  const onData = (buf) => {
    const text = buf.toString('utf8');
    task.log.push(text);
    if (task.log.length > 200) task.log.shift();
    const lines = text.split(/\r|\n/).filter(Boolean);
    for (const line of lines) {
      const pm = line.match(/\[进度\]\s*(\d+)%/);
      if (pm) {
        task.percent = parseInt(pm[1], 10);
        broadcast(task);
      } else if (line.includes('[完成]')) {
        const cm = line.match(/->\s*(.+)$/);
        if (cm) task.subtitle = cm[1].trim();
        task.status = 'done';
        task.percent = 100;
        broadcast(task);
      } else if (line.includes('[错误]') || line.toLowerCase().includes('error') || line.includes('Traceback')) {
        task.lastError = line.trim();
        saveTaskState(task);
        broadcast(task);
      }
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code) => {
    task.proc = null;
    if (task.status !== 'done') {
      if (code === 0) {
        task.status = 'done';
        task.percent = 100;
      } else {
        task.status = 'error';
        if (!task.lastError) task.lastError = `进程退出码 ${code}`;
      }
    }
    saveTaskState(task);
    broadcast(task);
  });
}

// 兜底：在整个 OUT_DIR（含子文件夹）下找最近 mtime 的视频文件
// 因为现在输出模板是 标题/标题 [id].ext，视频常落在子文件夹里
function findLatestVideo() {
  const exts = ['.mp4', '.mkv', '.webm', '.flv', '.mov', '.m4a', '.mp3'];
  let best = null;
  try {
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (e) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        try {
          if (e.isDirectory()) { walk(p); continue; }
          if (!exts.some(x => e.name.toLowerCase().endsWith(x))) continue;
          const st = fs.statSync(p);
          if (!best || st.mtimeMs > best.mtimeMs) best = { name: p, mtimeMs: st.mtimeMs };
        } catch (e) { /* 忽略无权限文件 */ }
      }
    };
    walk(OUT_DIR);
    return best ? best.name : '';
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 视频库：用 ffmpeg 取封面(第1秒)+时长+分辨率，结果缓存进 .thumbs/
// ---------------------------------------------------------------------------
const { execFile } = require('child_process');
// 本目录 ffmpeg/bin 只有 ffmpeg.exe，没有 ffprobe —— 直接解析 ffmpeg 输出取时长+分辨率
function ffprobeMeta(vidPath) {
  return new Promise((resolve) => {
    const ff = path.join(FFMPEG, 'ffmpeg.exe');
    execFile(ff, ['-hide_banner', '-i', vidPath], { timeout: 30000 }, () => {
      // ffmpeg 无输出文件会报错退出，但元数据在 stderr 里
    });
    execFile(ff, ['-hide_banner', '-i', vidPath], { timeout: 30000 }, (err, stdout, stderr) => {
      const out = stderr || '';
      const dm = out.match(/Duration:\s*(\d+):(\d+):(\d+)/);
      let duration = 0;
      if (dm) duration = (+dm[1]) * 3600 + (+dm[2]) * 60 + (+dm[3]);
      // 分辨率：行内形如 ", 1920x1080 [SAR..."，取第二个数字（高度）
      const vm = out.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      const height = vm ? parseInt(vm[2], 10) : 0;
      resolve(duration || height ? { duration, height } : null);
    });
  });
}
function makeThumb(vidPath, thumbName) {
  return new Promise((resolve) => {
    const out = path.join(THUMB_DIR, thumbName);
    if (fs.existsSync(out)) return resolve(true);   // 缓存命中
    const ff = path.join(FFMPEG, 'ffmpeg.exe');
    execFile(ff, ['-y', '-ss', '1', '-i', vidPath, '-frames:v', '1',
      '-vf', 'scale=480:-1', '-q:v', '4', out], { timeout: 60000 }, (err) => {
      resolve(!err && fs.existsSync(out));
    });
  });
}
async function videoMeta(vidPath, baseName, dirName, hasSub) {
  // 用视频路径的哈希做缩略图文件名：编码无关、稳定、无碰撞，
  // 不会像旧的 [^\w-]→'_' 那样把中文全替成下划线
  const thumbName = crypto.createHash('md5').update(vidPath).digest('hex').slice(0, 16) + '.jpg';
  const [meta, thumbOk] = await Promise.all([ffprobeMeta(vidPath), makeThumb(vidPath, thumbName)]);
  const duration = meta ? meta.duration : 0;
  const height = meta ? meta.height : 0;
  return {
    title: baseName.replace(/\s*\[[A-Za-z0-9_-]{11}\]$/, ''),
    dir: dirName,
    file: path.basename(vidPath),
    duration, height, hasSub,
    thumb: thumbOk ? '/thumb?name=' + encodeURIComponent(thumbName) : ''
  };
}

// 中文字幕判定：文件语言码里含 zh（如 zh / zh-Hans / zh-CN / ai-zh / zh-Hans-zh / zh-Hant-zh 等）
// yt-dlp 下载的机翻字幕常见 xxx.zh-Hans-zh.srt，这类后缀不能漏判
function isChineseSub(baseName, f) {
  if (!/\.(srt|vtt)$/i.test(f)) return false;
  const n = f.replace(/\.(srt|vtt)$/i, '');
  if (!n.startsWith(baseName + '.')) return false;
  const lang = n.slice(baseName.length + 1).toLowerCase();
  return lang.includes('zh') || lang === 'chi';
}
// 给定视频文件路径，扫描同目录下是否有同名中文字幕；返回找到的字幕路径（找不到返回 null）
function findChineseSubForFile(videoPath) {
  const base = path.basename(videoPath).replace(/\.[^.]+$/, '');
  let files = [];
  try { files = fs.readdirSync(path.dirname(videoPath)); } catch (e) { return null; }
  return files.find(f => isChineseSub(base, f)) || null;
}
function hasChineseSubForFile(videoPath) {
  return !!findChineseSubForFile(videoPath);
}

// 把任务状态广播给所有 SSE 连接
const sseClients = new Set();
function broadcast(task) {
  const payload = sanitize(task);
  for (const res of sseClients) {
    sendSSE(res, 'task', payload);
  }
}
function sanitize(t) {
  // hasSub：优先用下载完成时预算的值（按视频 ID 定位视频后判定，准确）；
  // 没有预算值时（如转写任务）再按 filename 兜底
  let hasSub = (typeof t.hasSub === 'boolean') ? t.hasSub : false;
  if (typeof t.hasSub !== 'boolean' && t.filename && /\.(webm|mp4|mkv)$/i.test(t.filename)) {
    hasSub = hasChineseSubForFile(t.filename);
  }
  return {
    id: t.id, url: t.url, status: t.status, percent: t.percent,
    size: t.size || '', speed: t.speed || '', eta: t.eta || '',
    filename: t.filename || '', merging: !!t.merging, lastError: t.lastError || '',
    kind: t.kind || '', subtitle: t.subtitle || '', hasSub
  };
}

const server = http.createServer((req, res) => {
  // CORS（本地用，允许所有）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = req.url.split('?')[0];

  // ===================== 视频库 =====================
  // 列出媒体库全部视频（封面+时长+分辨率+字幕标记），首次访问时用 ffmpeg 生成封面并缓存
  if (url === '/library' && req.method === 'GET') {
    (async () => {
      const items = [];
      let dirs = [];
      try { dirs = fs.readdirSync(OUT_DIR, { withFileTypes: true }); } catch (e) {}
      for (const d of dirs) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        const dir = path.join(OUT_DIR, d.name);
        let files = [];
        try { files = fs.readdirSync(dir); } catch (e) { continue; }
        const vid = files.find(f => /\.(webm|mp4|mkv)$/i.test(f));
        if (!vid) continue;
        const vidPath = path.join(dir, vid);
        const baseName = vid.replace(/\.[^.]+$/, '');
        // 字幕检测：精确匹配同名前缀的中文字幕文件（zh/zh-Hans/zh-CN/ai-zh/zh-Hans-zh 等）
        const hasSub = files.some(f => isChineseSub(baseName, f));
        items.push(await videoMeta(vidPath, baseName, d.name, hasSub));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, items }));
    })().catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

  // 缩略图文件服务（/thumb?name=xxx.jpg）
  if (url === '/thumb' && req.method === 'GET') {
    const name = decodeURIComponent((req.url.split('?name=')[1] || '').split('&')[0]);
    const p = path.join(THUMB_DIR, path.basename(name));
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(fs.readFileSync(p));
    } catch (e) {
      res.writeHead(404); res.end();
    }
    return;
  }

  // SSE 进度流
  if (url === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    sseClients.add(res);
    // 初始推送当前所有任务
    for (const t of tasks.values()) sendSSE(res, 'task', sanitize(t));
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // 提交下载任务
  if (url === '/add' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let urls = [];
      try { urls = JSON.parse(body).urls || []; } catch (e) {}
      urls = urls.map(u => String(u).trim()).filter(Boolean);
      const created = [];
      for (const u of urls) {
        const id = ++taskSeq;
        const task = { id, url: u, status: 'queued', percent: 0 };
        tasks.set(id, task);
        startDownload(task);
        created.push(id);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ids: created }));
    });
    return;
  }

  // 取消某个任务
  if (url === '/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const id = JSON.parse(body).id;
      const t = tasks.get(id);
      if (t && t.proc) { t.proc.kill('SIGTERM'); t.status = 'canceled'; broadcast(t); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // 用离线语音模型把视频音频转成中文字幕（复用 listen 项目的环境/模型）
  if (url === '/transcribe' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let id = null, url = '';
      try { ({ id, url } = JSON.parse(body)); } catch (e) {}
      // 与 /open 同样的查找顺序：内存 -> 持久化按 id -> 持久化按 url
      // 注意：persistedTasks 的 key 来自 JSON（字符串），而前端传的 id 是数字，需同时尝试两种类型
      const idKey = String(id);
      let t = tasks.get(id) || tasks.get(idKey) || persistedTasks.get(id) || persistedTasks.get(idKey);
      if (!t && url) {
        let match = null;
        for (const p of persistedTasks.values()) {
          if (p.url === url && p.status === 'done') {
            if (!match || (p.savedAt && p.savedAt > match.savedAt)) match = p;
          }
        }
        if (match) t = match;
      }
      if (!t || t.status !== 'done' || !t.filename) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'task not done or no file' }));
        return;
      }
      // 找到视频文件绝对路径；找不到（如持久化里只有相对名）则尝试拼 BASE
      const videoPath = resolveVideoFile(t);
      if (!videoPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'video file not found on disk' }));
        return;
      }
      const newId = ++taskSeq;
      const task = {
        id: newId, url: t.url, status: 'transcribing', percent: 0,
        kind: 'transcribe', filename: t.filename, videoPath
      };
      tasks.set(newId, task);
      startTranscribe(task);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: newId }));
    });
    return;
  }

  // 打开文件 / 所在文件夹（仅限已完成的任务，路径必须在本目录内，防目录穿越）
  if (url === '/open' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let id = null, mode = 'folder', url = '';
      try { ({ id, mode, url } = JSON.parse(body)); } catch (e) {}
      // 查找顺序：内存里 → 持久化按 id → 持久化按 url 找最后一次匹配
      // （最后这个兜底是为了应对服务重启后 id 失效但磁盘文件还在的情况）
      // 注意 persistedTasks 的 key 来自 JSON（字符串），前端传的 id 是数字，需同时尝试两种类型
      const idKey = String(id);
      let t = tasks.get(id) || tasks.get(idKey) || persistedTasks.get(id) || persistedTasks.get(idKey);
      if (!t && url) {
        let match = null;
        for (const p of persistedTasks.values()) {
          if (p.url === url && p.status === 'done') {
            if (!match || (p.savedAt && p.savedAt > match.savedAt)) match = p;
          }
        }
        if (match) t = match;
      }
      if (!t || t.status !== 'done') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'task not done or no file' }));
        return;
      }
      // 优先按视频 ID 精确定位文件（避免下载完成时安全网误指其他视频）
      // 离线转写任务(mode=file)优先打开生成的 srt 字幕
      let filePath;
      if (t.kind === 'transcribe' && t.subtitle) {
        filePath = path.resolve(BASE, t.subtitle);
      } else {
        filePath = resolveVideoByTask(t) || path.resolve(BASE, t.filename);
      }
      const baseDir = path.resolve(BASE) + path.sep;
      if (!filePath.startsWith(baseDir)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'path outside base dir' }));
        return;
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'file missing on disk' }));
        return;
      }
      // folder 模式：资源管理器打开并选中该文件；file 模式：用默认播放器播放
      const cmd = mode === 'file'
        ? `start "" "${filePath}"`
        : `explorer /select,"${filePath}"`;
      require('child_process').exec(cmd, { windowsHide: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // 视频库：播放/打开文件夹（dir + file 定位，路径锁定在媒体库内）
  if (url === '/open-library' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let dir = '', file = '', mode = 'folder';
      try { ({ dir, file, mode } = JSON.parse(body)); } catch (e) {}
      if (!dir || !file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing dir/file' }));
        return;
      }
      const filePath = path.resolve(OUT_DIR, dir, path.basename(file));
      const baseDir = path.resolve(OUT_DIR) + path.sep;
      if (!filePath.startsWith(baseDir)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'path outside library' }));
        return;
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'file missing' }));
        return;
      }
      const cmd = mode === 'file'
        ? `start "" "${filePath}"`
        : `explorer /select,"${filePath}"`;
      require('child_process').exec(cmd, { windowsHide: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // 静态页面
  if (url === '/' || url === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(BASE, 'index.html')));
    } catch (e) {
      res.writeHead(500); res.end('index.html missing');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[ERROR] Port ${PORT} is already in use. Close the old download service window first, then restart.`);
  } else {
    console.error('[ERROR] Server failed to start:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`yt-dlp download UI is running at http://127.0.0.1:${PORT}`);
  console.log(`Save directory: ${OUT_DIR}`);
  console.log('Keep this window OPEN while using the UI. Close it to stop the service.');

  // 启动即体检：yt-dlp 是 108KB 的 pip 桩或缺失时，后台自动拉官方独立版
  ensureYtdlp();
  // 每 30 秒复检一次，修复完成后无需重启服务
  setInterval(() => { if (!ytdlpHealth.ok) ensureYtdlp(); }, 30000).unref();
});
