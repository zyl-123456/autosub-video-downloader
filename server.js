/**
 * 本地视频下载服务（yt-dlp Web UI）
 * ------------------------------------------------
 * 功能：
 *  - 接收前端 POST 的链接列表，为每条链接启动一个 yt-dlp 进程
 *  - 解析 yt-dlp 的进度输出（百分比/速度/ETA），通过 SSE 实时推回前端
 *  - 每条视频自动存入同名文件夹（视频 + 字幕）
 *  - 下载完成后自动检测中文字幕：缺失则调用本地 Whisper（faster-whisper）
 *    离线转写音频，生成简体中文字幕（SRT），全程无需手动干预
 *
 * 所有个性化配置见 config.json（参考 config.example.json）：
 *  port / proxy / downloadDir / python / whisperModel / language / cookiesFromBrowser
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// 配置加载：config.json（不入库）→ 缺省值兜底
// ---------------------------------------------------------------------------
const BASE = __dirname;
const DEFAULT_CFG = {
  port: 8731,
  proxy: '',                 // 形如 http://127.0.0.1:7897；留空则不走代理
  downloadDir: '',           // 视频保存目录；留空 = 本项目目录
  python: 'python',          // 装有 faster-whisper 的 Python 解释器（字幕转写用）
  whisperModel: '',          // 本地 Whisper 模型目录；留空 = 首次运行自动从 HuggingFace 下载 large-v3
  language: 'zh',            // 字幕语言（转写 + 下载字幕优先语言）
  cookiesFromBrowser: ''     // 形如 "chrome" / "edge"；一般优先用 cookies.txt
};
const CFG = loadConfig();
function loadConfig() {
  const cfg = { ...DEFAULT_CFG };
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(BASE, 'config.json'), 'utf8')));
  } catch (e) { /* 无 config.json 时用缺省值 */ }
  return cfg;
}

const PORT = CFG.port;
const OUT_DIR = CFG.downloadDir ? path.resolve(BASE, CFG.downloadDir) : BASE;

// yt-dlp 可执行文件：优先用本项目目录里的，其次用 PATH 里的
function findYtDlp() {
  const local = path.join(BASE, 'yt-dlp.exe');
  if (fs.existsSync(local)) return local;
  const localUnix = path.join(BASE, 'yt-dlp');
  if (fs.existsSync(localUnix)) return localUnix;
  return 'yt-dlp'; // 交给 PATH
}
const YTDL = findYtDlp();

// ffmpeg：优先用本项目 ffmpeg/bin，其次交给 PATH（yt-dlp 自己找）
function findFfmpegDir() {
  const dir = path.join(BASE, 'ffmpeg', 'bin');
  if (fs.existsSync(path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))) return dir;
  return '';
}
const FFMPEG = findFfmpegDir();

// 转写用的 Python 解释器与模型（server → python 通过环境变量传递）
const LISTEN_PY = CFG.python;
const TRANSCRIBE_SCRIPT = path.join(BASE, 'transcribe_video.py');

// 简易任务表：id -> {url, proc, status, percent, ...}
const tasks = new Map();
let taskSeq = 0;

// 持久化任务日志：服务重启也能找回已完成任务的 filename，
// 避免点"打开/文件夹"报"task not done or no file"
const taskLogPath = path.join(OUT_DIR, '.task-log.json');
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

function startDownload(task) {
  const args = [];
  if (CFG.proxy) args.push('--proxy', CFG.proxy);
  if (FFMPEG) args.push('--ffmpeg-location', FFMPEG);
  args.push(
    '-P', OUT_DIR,
    '-o', '%(title)s/%(title)s [%(id)s].%(ext)s',   // 每条视频自动建同名文件夹，视频+字幕都存里面
    '--newline',
    '--no-playlist',          // 单条链接默认不下整个列表，避免误下整集
    // 字幕：优先真人上传的简体中文字幕；ai-zh 是 B 站的 AI 字幕语言代码
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', 'zh-Hans,zh-CN,zh-Hans-zh,ai-zh',
    '--convert-subs', 'srt',
    '--embed-subs',
  );

  // Cookie 池：目录里所有 cookies*.txt 自动合并，按域名生效；
  // 池为空时用 config.json 的 cookiesFromBrowser。
  const cookiePool = buildCookiePool();
  if (cookiePool) {
    args.push('--cookies', cookiePool);
  } else if (CFG.cookiesFromBrowser) {
    args.push('--cookies-from-browser', CFG.cookiesFromBrowser);
  }

  args.push(task.url);

  task.status = 'downloading';
  task.percent = 0;
  task.log = [];

  // PYTHONUTF8=1 强制 yt-dlp(Python) 用 UTF-8 输出，避免 Windows 管道下中文标题变 GBK 乱码
  const env = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  let proc;
  try {
    proc = spawn(YTDL, args, { cwd: BASE, windowsHide: true, env });
  } catch (e) {
    task.status = 'error';
    task.lastError = '启动 yt-dlp 失败：' + e.message;
    saveTaskState(task);
    broadcast(task);
    return;
  }
  proc.on('error', (e) => {
    task.status = 'error';
    task.lastError = '找不到 yt-dlp 可执行文件：' + e.message;
    saveTaskState(task);
    broadcast(task);
  });
  task.proc = proc;

  const onData = (buf) => {
    // yt-dlp 已通过 PYTHONUTF8=1 输出 UTF-8，显式按 UTF-8 解码
    const text = buf.toString('utf8');
    task.log.push(text);
    if (task.log.length > 200) task.log.shift();
    // yt-dlp 每行以 \r 刷新进度，--newline 后多为 \n
    const lines = text.split(/\r|\n/).filter(Boolean);
    for (const line of lines) {
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
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code) => {
    task.proc = null;
    if (code === 0) {
      task.status = 'done';
      task.percent = 100;
      // 安全网：如果 [Merger]/[Destination] 行因输出缓冲没被捕获到，
      // 就拿输出目录下最近改动的视频文件顶上，免得点打开按钮报"无文件"
      if (!task.filename) {
        task.filename = findLatestVideo();
      }
      saveTaskState(task);
      broadcast(task);
      // 自动字幕：下载完成后若没有中文字幕，自动触发离线转写（无需手动）
      // 用 URL 里的视频 ID 在目录里精确定位本次下载的视频，避免误指其他视频
      const vp = resolveVideoByTask(task);
      if (vp && !hasSubtitle(vp) && !task.startedAutoSub) {
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
// 离线语音转文字（本地 Whisper / faster-whisper，配置见 config.json）
// 把视频/音频的语音转成简体中文字幕(SRT)，落进同名文件夹
// ---------------------------------------------------------------------------
// 根据已完成任务的 filename 找到对应的视频文件绝对路径
function resolveVideoFile(task) {
  if (!task || !task.filename) return null;
  const p = path.resolve(BASE, task.filename);
  if (fs.existsSync(p) && /\.(webm|mp4|mkv|flv|mov|m4v|avi)$/i.test(p)) return p;
  return null;
}

// 判断某视频文件旁边是否已存在 .zh.srt
function hasSubtitle(videoPath) {
  if (!videoPath) return false;
  const base = videoPath.replace(/\.[^.]+$/, '');
  return fs.existsSync(base + '.zh.srt');
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
  if (hasSubtitle(videoPath)) {
    task.status = 'done';
    task.percent = 100;
    task.filename = videoPath;
    task.subtitle = videoPath.replace(/\.[^.]+$/, '') + '.zh.srt';
    saveTaskState(task);
    broadcast(task);
    return;
  }

  task.status = 'transcribing';
  task.percent = 0;
  task.kind = 'transcribe';     // 标记任务类型，前端据此显示不同文案
  task.log = [];

  const env = Object.assign({}, process.env, {
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    ASD_WHISPER_MODEL: CFG.whisperModel || '',   // 空则由脚本自动下载 large-v3
    ASD_LANGUAGE: CFG.language || 'zh'
  });
  let proc;
  try {
    proc = spawn(LISTEN_PY, [TRANSCRIBE_SCRIPT, videoPath], {
      cwd: BASE, windowsHide: true, env
    });
  } catch (e) {
    task.status = 'error';
    task.lastError = '启动转写进程失败（检查 config.json 的 python 路径）：' + e.message;
    saveTaskState(task);
    broadcast(task);
    return;
  }
  // spawn 异步错误（如解释器路径不存在）兜底，避免单个任务拖垮整个服务
  proc.on('error', (e) => {
    task.status = 'error';
    task.lastError = '转写进程错误（检查 config.json 的 python 路径）：' + e.message;
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

// 把任务状态广播给所有 SSE 连接
const sseClients = new Set();
function broadcast(task) {
  const payload = sanitize(task);
  for (const res of sseClients) {
    sendSSE(res, 'task', payload);
  }
}
function sanitize(t) {
  // 对已完成视频任务，检测旁边是否已有中文字幕（YouTube 字幕或离线转写产物）
  let hasSub = false;
  if (t.filename && /\.(webm|mp4|mkv)$/i.test(t.filename)) {
    const base = t.filename.replace(/\.[^.]+$/, '');
    hasSub = fs.existsSync(base + '.zh.srt') ||
             fs.existsSync(base + '.zh-Hans.srt') ||
             fs.existsSync(base + '.zh-CN.srt');
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

  // 前端启动时读一次配置（保存目录 / 是否走代理）
  if (url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, saveDir: OUT_DIR, hasProxy: !!CFG.proxy }));
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

  // 用离线语音模型把视频音频转成中文字幕
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
      const baseDir = path.resolve(OUT_DIR) + path.sep;
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

  // 静态页面
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(BASE, 'index.html')));
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
});
