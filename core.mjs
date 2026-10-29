export const ALARM_PREFIX = 'browser-trigger:';
export const DATA_KEY = 'browserTriggerV1';

export function pageUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请输入不含用户名或密码的 HTTP / HTTPS 地址。');
  }
  url.hash = '';
  return url.href;
}

export function addressTarget(input) {
  const value = String(input ?? '').trim();
  if (!value || value.length > 2048) throw new Error('请输入有效网站或页面地址。');
  const url = new URL(pageUrl(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`));
  return { mode: 'address', match: url.pathname === '/' && !url.search ? 'site' : 'page', url: url.href };
}

export function matchesTarget(target, value) {
  try {
    const actual = new URL(pageUrl(value));
    return target.match === 'site' ? actual.origin === new URL(target.url).origin : actual.href === target.url;
  } catch { return false; }
}

export function validateDraft(draft) {
  const name = String(draft.name ?? '').trim();
  const minutes = Number(draft.minutes);
  if (!name || name.length > 60) throw new Error('名称请填写 1 至 60 个字符。');
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080) throw new Error('刷新间隔须为 1 至 10080 分钟。');
  if (!['normal', 'hard'].includes(draft.action)) throw new Error('请选择刷新动作。');
  if (!['address', 'tab'].includes(draft.mode)) throw new Error('请选择目标方式。');
  return { name, minutes, action: draft.action };
}

export function availableTabs(tabs) {
  return tabs.filter(tab => Number.isInteger(tab.id) && !tab.incognito && /^https?:\/\//.test(tab.url ?? ''));
}
