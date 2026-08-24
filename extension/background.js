// Service Worker：注册右键菜单「下载此页面视频」
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'autosub-download-page',
    title: '📥 下载此页面视频（本地下载器）',
    contexts: ['page', 'link']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'autosub-download-page') return;
  // 优先用右键点中的链接（contexts 里含 link），否则用当前页面
  const url = info.linkUrl || (tab && tab.url);
  if (!url) return;
  try {
    await fetch('http://127.0.0.1:8731/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [url] })
    });
  } catch (e) {
    // 静默失败（service worker 无法弹窗）；用户可点扩展图标看详细错误
  }
});
