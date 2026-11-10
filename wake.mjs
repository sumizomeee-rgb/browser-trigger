try {
  const reply = await chrome.runtime.sendMessage({ type: 'startup' });
  if (!reply?.ok) throw new Error(reply?.error ?? '扩展未响应');
  const rules = reply.data.rules.filter(rule => rule.enabled && rule.action === 'ensure');
  if (!rules.length) throw new Error('请先在页面触发器中登记并启用保活条目。');
  if (rules.some(rule => !['opened', 'present'].includes(rule.lastResult?.code))) throw new Error('部分保活页面未能打开，请在页面触发器中查看结果。');
  const tab = await chrome.tabs.getCurrent();
  await chrome.tabs.remove(tab.id);
} catch (error) {
  document.querySelector('#status').textContent = error.message;
}
