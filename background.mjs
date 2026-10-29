import { createEngine } from './engine.mjs';

const engine = createEngine(chrome);
const logFailure = error => console.error('页面触发器：操作未完成。', error.name);
engine.ready.catch(logFailure);

// 顶层注册监听器，以便休眠后的 worker 能被 Chrome 正常唤醒。
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options.html')) return false;
  engine.message(message).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { engine.onAlarm(alarm).catch(logFailure); });
chrome.tabs.onRemoved.addListener(tabId => { engine.onRemoved(tabId).catch(logFailure); });
chrome.runtime.onStartup.addListener(() => { engine.ready.catch(logFailure); });
chrome.runtime.onInstalled.addListener(() => { engine.ready.catch(logFailure); });
chrome.action.onClicked.addListener(() => { chrome.runtime.openOptionsPage().catch(logFailure); });
