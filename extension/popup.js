// popup 逻辑：读当前标签页 URL → POST 到本地服务 /add
const API = 'http://127.0.0.1:8731';
const $ = (id) => document.getElementById(id);

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(url) {
  const r = await fetch(API + '/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [url] })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function setStatus(text, cls) {
  const s = $('status');
  s.textContent = text;
  s.className = 'status ' + (cls || '');
}

document.addEventListener('DOMContentLoaded', async () => {
  const tab = await getCurrentTab();
  const url = tab ? tab.url : '';
  const btn = $('send');

  if (!url || !/^https?:\/\//i.test(url)) {
    $('url').textContent = '当前页面不是可下载的网页（chrome:// 等内部页面不支持）';
    btn.disabled = true;
    return;
  }
  $('url').textContent = url;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    setStatus('发送中…', '');
    try {
      const r = await send(url);
      if (r.ok) {
        btn.textContent = '✓ 已发送';
        btn.className = 'ok';
        setStatus('已加入下载队列，去界面看进度 →', 'ok');
      } else {
        throw new Error('服务返回失败');
      }
    } catch (e) {
      btn.disabled = false;
      setStatus('连接失败：' + e.message + '（服务没启动？）', 'err');
    }
  });
});
