import { addressTarget, matchesTarget } from './core.mjs';

const $ = selector => document.querySelector(selector);
let state = { rules: [], tabs: [] };
let editingId = null;
let deletingId = null;
let toastTimer;
const stateLabels = { needs_confirmation: '请重新确认页签', needs_selection: '请选定一个页签', closed: '目标已关闭', waiting: '等待匹配页面', error: '安排失败' };

async function request(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.error ?? '扩展暂时未响应，请更新列表。');
  return response.data;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').className = error ? 'error-toast' : '';
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}
function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}
function time(value) {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function action(label, name, id, className) {
  const button = text('button', label, className);
  button.dataset.action = name;
  button.dataset.id = id;
  return button;
}
function render() {
  $('#loading').hidden = true;
  $('#empty').hidden = state.rules.length > 0;
  $('#rules-table').hidden = state.rules.length === 0;
  $('#rule-count').textContent = state.rules.length;
  const active = state.rules.filter(rule => rule.enabled).length;
  $('#active-count').textContent = active ? `${active} 个条目定时中` : '尚未启用定时';
  const body = $('#rules-body');
  body.replaceChildren();
  for (const rule of state.rules) {
    const row = document.createElement('tr');
    row.dataset.ruleId = rule.id;
    const target = document.createElement('td');
    target.append(text('div', rule.name, 'rule-name'), text('div', rule.target.mode === 'tab' ? '指定页签' : rule.target.match === 'site' ? '网站匹配' : '页面地址匹配', 'target-type'), text('div', rule.target.url, 'target-url'));
    const timing = document.createElement('td');
    timing.append(text('div', rule.action === 'hard' ? '强制刷新' : '普通刷新'), text('div', `每 ${rule.minutes} 分钟`, 'interval'));
    const status = document.createElement('td');
    const toggle = action('', 'toggle', rule.id, 'toggle');
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(rule.enabled));
    toggle.setAttribute('aria-label', `${rule.enabled ? '暂停' : '启用'} ${rule.name}`);
    toggle.append(text('span', '', 'toggle-track'), text('span', rule.enabled ? '已启用' : '已暂停'));
    status.append(toggle);
    if (stateLabels[rule.state]) status.append(text('div', stateLabels[rule.state], 'state-note'));
    if (rule.enabled && rule.nextRunAt) status.append(text('div', `下次 ${time(rule.nextRunAt)}`, 'next-time'));
    const last = document.createElement('td');
    const warning = ['ambiguous', 'missing', 'closed', 'changed', 'waiting', 'interrupted', 'busy'].includes(rule.lastResult?.code);
    last.append(text('div', rule.lastResult?.message ?? '尚未执行', `result-text${warning ? ' warning' : rule.lastResult?.code === 'error' ? ' failed' : ''}`));
    if (rule.lastResult) last.append(text('div', time(rule.lastResult.at), 'result-time'));
    const actions = document.createElement('td');
    const stack = text('div', '', 'row-actions');
    const minor = text('div', '', 'minor-actions');
    minor.append(action('编辑', 'edit', rule.id), action('删除', 'delete', rule.id));
    stack.append(action('执行一次', 'run', rule.id, 'run-button'), minor);
    actions.append(stack);
    row.append(target, timing, status, last, actions);
    body.append(row);
  }
}
async function refresh() {
  state = await request('snapshot');
  render();
}
function fillTabs(selected) {
  const select = $('#tab-select');
  select.replaceChildren(new Option('请选择一个页签', ''));
  for (const tab of state.tabs) select.add(new Option(`${tab.title || '未命名页签'} — ${tab.url}`, String(tab.id)));
  if (selected != null && state.tabs.some(tab => tab.id === Number(selected))) select.value = String(selected);
}
function updateTargetFields() {
  const mode = $('input[name=mode]:checked').value;
  $('#tab-fields').hidden = mode !== 'tab';
  $('#address-fields').hidden = mode !== 'address';
  $('#tab-select').required = mode === 'tab';
  $('#target-address').required = mode === 'address';
  previewAddress();
}
function previewAddress() {
  const preview = $('#match-preview');
  preview.textContent = '';
  preview.className = 'match-preview';
  if (!$('#target-address').value.trim()) return;
  try {
    const target = addressTarget($('#target-address').value);
    const count = state.tabs.filter(tab => matchesTarget(target, tab.url)).length;
    preview.textContent = `${target.match === 'site' ? '匹配网站' : '精确页面'}：${target.match === 'site' ? new URL(target.url).origin : target.url}。${count === 0 ? '当前没有匹配页签，将等待。' : count === 1 ? '当前匹配 1 个页签。' : `当前匹配 ${count} 个页签，请切换到“选择已打开页签”指定一个。`}`;
    preview.classList.toggle('warning', count > 1);
  } catch { preview.textContent = '请填写有效的网站或页面地址。'; preview.classList.add('warning'); }
}
async function openEditor(id = null) {
  await refresh();
  editingId = id;
  const rule = state.rules.find(item => item.id === id);
  if (id && !rule) return toast('条目已不存在。', true);
  $('#rule-form').reset();
  $('#editor-title').textContent = rule ? '编辑条目' : '新增条目';
  $('#form-error').textContent = '';
  $('#rule-name').value = rule?.name ?? '';
  $('#rule-action').value = rule?.action ?? 'normal';
  $('#rule-minutes').value = rule?.minutes ?? 5;
  $(`input[name=mode][value=${rule?.target.mode ?? 'tab'}]`).checked = true;
  $('#target-address').value = rule?.target.mode === 'address' ? rule.target.url : '';
  fillTabs(rule?.boundTabId);
  updateTargetFields();
  $('#editor').showModal();
}
$('#add-rule').addEventListener('click', () => openEditor().catch(error => toast(error.message, true)));
$('#empty-add').addEventListener('click', () => openEditor().catch(error => toast(error.message, true)));
for (const id of ['close-editor', 'cancel-editor']) $('#' + id).addEventListener('click', () => $('#editor').close());
$('#refresh-list').addEventListener('click', () => refresh().catch(error => toast(error.message, true)));
$('#refresh-tabs').addEventListener('click', async () => {
  const selected = $('#tab-select').value;
  try { await refresh(); fillTabs(selected); previewAddress(); } catch (error) { toast(error.message, true); }
});
for (const radio of document.querySelectorAll('input[name=mode]')) radio.addEventListener('change', updateTargetFields);
$('#target-address').addEventListener('input', previewAddress);
$('#rule-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#save-rule').disabled = true;
  try {
    state = await request('save', { draft: { id: editingId, name: $('#rule-name').value, mode: $('input[name=mode]:checked').value, tabId: $('#tab-select').value, address: $('#target-address').value, minutes: $('#rule-minutes').value, action: $('#rule-action').value } });
    render();
    $('#editor').close();
    toast('条目已保存，定时保持暂停。');
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { $('#save-rule').disabled = false; }
});
$('#rules-body').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const { action: type, id } = button.dataset;
  button.disabled = true;
  try {
    if (type === 'edit') return await openEditor(id);
    if (type === 'delete') {
      deletingId = id;
      $('#delete-name').textContent = state.rules.find(rule => rule.id === id)?.name ?? '';
      $('#delete-dialog').returnValue = 'cancel';
      $('#delete-dialog').showModal();
      return;
    }
    const data = type === 'toggle'
      ? await request('toggle', { id, enabled: !state.rules.find(rule => rule.id === id).enabled })
      : await request('run', { id });
    if (data?.skipped) toast('该条目正在执行，本次未重复提交。');
    else { state = data; render(); if (type === 'run') toast(state.rules.find(rule => rule.id === id)?.lastResult?.message ?? '执行结束。'); }
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
$('#delete-dialog').addEventListener('close', async () => {
  if ($('#delete-dialog').returnValue !== 'delete') return;
  try { state = await request('remove', { id: deletingId }); render(); toast('条目已删除。'); }
  catch (error) { toast(error.message, true); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' || area === 'session') && !$('#editor').open) refresh().catch(error => toast(error.message, true));
});
refresh().catch(error => { $('#loading').textContent = error.message; toast(error.message, true); });
