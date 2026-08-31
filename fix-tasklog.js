// fix-tasklog.js —— 修复 .task-log.json 里历史乱码的 filename
// 原理：乱码 filename 里的视频 ID（[xxx] 部分，纯 ASCII 不会乱）是可信的，
//       用它在磁盘 downloaded videos/ 里精确定位真实视频文件，重建正确 filename。
// 用法：node fix-tasklog.js   （自动备份 .task-log.json -> .task-log.json.bak）
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '.task-log.json');
const OUT_DIR = path.join(__dirname, 'downloaded videos');

if (!fs.existsSync(LOG_PATH)) {
  console.log('未找到 .task-log.json，无需修复');
  process.exit(0);
}

const arr = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));

// 1) 扫描磁盘，只保留视频扩展名文件，建 ID -> 绝对路径映射
const idMap = {};
const VIDEO_EXT = /\.(webm|mp4|mkv|flv|mov|m4v|avi)$/i;
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!VIDEO_EXT.test(e.name)) continue;
    const m = e.name.match(/\[([A-Za-z0-9_-]{11})\]/);
    if (m) idMap[m[1]] = p;
  }
}
walk(OUT_DIR);

// 2) 备份
fs.writeFileSync(LOG_PATH + '.bak', fs.readFileSync(LOG_PATH));

// 3) 修复乱码条目
let fixed = 0, skipped = 0;
for (const t of arr) {
  const name = t.filename || '';
  if (!name.includes('\uFFFD')) continue;
  const m = name.match(/\[([A-Za-z0-9_-]{11})\]/);
  if (m && idMap[m[1]]) {
    const oldName = t.filename;
    t.filename = idMap[m[1]];
    fixed++;
    console.log('修复: [' + m[1] + ']');
    console.log('  旧: ' + JSON.stringify(oldName));
    console.log('  新: ' + JSON.stringify(t.filename));
  } else {
    skipped++;
    console.log('跳过(未匹配到视频): ' + JSON.stringify(name.slice(0, 80)));
  }
}

fs.writeFileSync(LOG_PATH, JSON.stringify(arr, null, 2));
console.log('--- 完成: 修复 ' + fixed + ' 条, 跳过 ' + skipped + ' 条; 备份在 .task-log.json.bak ---');
