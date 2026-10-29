import { ALARM_PREFIX, DATA_KEY, addressTarget, availableTabs, matchesTarget, pageUrl, validateDraft } from './core.mjs';

export function createEngine(api, { now = () => Date.now(), newId = () => crypto.randomUUID() } = {}) {
  let tail = Promise.resolve();
  const pending = new Set();
  const serial = work => {
    const task = tail.then(work);
    tail = task.catch(() => {});
    return task;
  };
  const alarmName = rule => `${ALARM_PREFIX}${rule.id}/${rule.alarmToken}`;
  async function readRules() {
    const data = (await api.storage.local.get(DATA_KEY))[DATA_KEY];
    if (data && (data.version !== 1 || !Array.isArray(data.rules))) throw new Error('配置格式不受支持，未改动已有数据。');
    return data?.rules ?? [];
  }
  const writeRules = rules => api.storage.local.set({ [DATA_KEY]: { version: 1, rules } });
  const readBindings = async () => (await api.storage.session.get('bindings')).bindings ?? {};
  const writeBindings = bindings => api.storage.session.set({ bindings });
  const result = (rule, code, message) => { rule.lastResult = { code, message, at: now() }; };
  const find = (rules, id) => {
    const rule = rules.find(item => item.id === id);
    if (!rule) throw new Error('条目已不存在，请刷新列表。');
    return rule;
  };
  async function schedule(rule, when = now() + rule.minutes * 60000) {
    rule.nextRunAt = null;
    if (!rule.enabled) { await api.alarms.clear(alarmName(rule)); return; }
    try {
      await api.alarms.create(alarmName(rule), { when, periodInMinutes: rule.minutes });
      rule.nextRunAt = when;
    } catch {
      rule.enabled = false;
      rule.state = 'error';
      result(rule, 'error', '定时安排失败，已暂停；请重新启用。');
      await api.alarms.clear(alarmName(rule));
    }
  }
  async function snapshot() {
    const bindings = await readBindings();
    const tabs = availableTabs(await api.tabs.query({})).map(({ id, title, url, windowId }) => ({ id, title, url, windowId }));
    return { rules: (await readRules()).map(rule => ({ ...rule, boundTabId: bindings[rule.id]?.tabId ?? null })), tabs };
  }
  async function recover() {
    const rules = await readRules();
    const bindings = await readBindings();
    const alarms = new Map((await api.alarms.getAll()).map(alarm => [alarm.name, alarm]));
    for (const rule of rules) {
      if (rule.target.mode === 'tab' && !bindings[rule.id]) {
        rule.enabled = false;
        rule.state = 'needs_confirmation';
      }
      if (rule.lastResult?.code === 'requesting') result(rule, 'interrupted', '上次执行被中断，未补刷。');
      const alarm = alarms.get(alarmName(rule));
      if (!rule.enabled) await schedule(rule);
      else if (!alarm || alarm.periodInMinutes !== rule.minutes) {
        await schedule(rule, rule.nextRunAt > now() ? rule.nextRunAt : now() + rule.minutes * 60000);
      } else rule.nextRunAt = alarm.scheduledTime;
      alarms.delete(alarmName(rule));
    }
    for (const name of alarms.keys()) if (name.startsWith(ALARM_PREFIX)) await api.alarms.clear(name);
    await writeRules(rules);
  }
  const ready = serial(recover);

  async function save(draft) {
    const values = validateDraft(draft);
    const rules = await readRules();
    if (!draft.id && rules.length >= 100) throw new Error('第一版最多保存 100 个条目。');
    const old = draft.id ? find(rules, draft.id) : null;
    const id = old?.id ?? newId();
    const bindings = await readBindings();
    let target;
    if (draft.mode === 'tab') {
      let tab;
      try { tab = await api.tabs.get(Number(draft.tabId)); } catch { throw new Error('所选页签已关闭，请重新选择。'); }
      if (!availableTabs([tab]).length || (tab.pendingUrl && pageUrl(tab.pendingUrl) !== pageUrl(tab.url))) {
        throw new Error('所选页签正在跳转或不支持，请重新选择。');
      }
      target = { mode: 'tab', match: 'page', url: pageUrl(tab.url), title: tab.title ?? '' };
      bindings[id] = { tabId: tab.id, url: target.url };
    } else {
      target = addressTarget(draft.address);
      delete bindings[id];
    }
    // 新增和编辑均暂停，启用必须另行明确操作。
    if (old) await api.alarms.clear(alarmName(old));
    const rule = { id, ...values, target, enabled: false, state: 'paused', alarmToken: newId(), nextRunAt: null, lastResult: old?.lastResult ?? null };
    if (old) rules[rules.indexOf(old)] = rule; else rules.push(rule);
    await schedule(rule);
    await writeBindings(bindings);
    await writeRules(rules);
    return snapshot();
  }
  async function toggle(id, enabled) {
    const rules = await readRules();
    const rule = find(rules, id);
    if (typeof enabled !== 'boolean') throw new Error('启停参数无效。');
    if (enabled && rule.target.mode === 'tab' && !(await readBindings())[id]) throw new Error('请编辑条目，重新选择并确认页签。');
    await api.alarms.clear(alarmName(rule));
    if (enabled) rule.alarmToken = newId();
    rule.enabled = enabled;
    rule.state = enabled ? 'ready' : 'paused';
    await schedule(rule);
    await writeRules(rules);
    return snapshot();
  }
  async function remove(id) {
    const rules = await readRules();
    const rule = find(rules, id);
    await api.alarms.clear(alarmName(rule));
    const bindings = await readBindings();
    delete bindings[id];
    await writeBindings(bindings);
    await writeRules(rules.filter(rule => rule.id !== id));
    return snapshot();
  }
  async function execute(id, source, alarm) {
    const rules = await readRules();
    const rule = rules.find(item => item.id === id);
    if (!rule) return { skipped: 'deleted' };
    if (source === 'alarm') {
      if (!rule.enabled || alarm.name !== alarmName(rule)
        || alarm.scheduledTime <= (rule.lastAlarmAt ?? 0)
        || alarm.scheduledTime < (rule.ignoreAlarmBefore ?? 0)) return { skipped: 'stale' };
      rule.lastAlarmAt = alarm.scheduledTime;
    } else rule.ignoreAlarmBefore = now();
    const bindings = await readBindings();
    let candidates = [];
    if (rule.target.mode === 'tab') {
      const binding = bindings[id];
      if (binding) {
        try { candidates = availableTabs([await api.tabs.get(binding.tabId)]); } catch { /* 关闭目标时暂停 */ }
      }
      if (!binding || !candidates.length) {
        rule.enabled = false;
        rule.state = 'needs_confirmation';
        delete bindings[id];
        result(rule, 'missing', '目标页签已关闭或绑定失效，请重新选择。');
      } else if (!matchesTarget(rule.target, candidates[0].pendingUrl ?? candidates[0].url)) {
        rule.enabled = false;
        rule.state = 'needs_confirmation';
        delete bindings[id];
        candidates = [];
        result(rule, 'changed', '目标地址已变化，已暂停；请重新选择页签。');
      }
    } else {
      candidates = availableTabs(await api.tabs.query({})).filter(tab => matchesTarget(rule.target, tab.url));
      if (!candidates.length) {
        rule.state = rule.enabled ? 'waiting' : 'paused';
        result(rule, 'waiting', '没有匹配页签，等待下次检查；不会自动打开页面。');
      } else if (candidates.length > 1) {
        rule.enabled = false;
        rule.state = 'needs_selection';
        result(rule, 'ambiguous', `匹配到 ${candidates.length} 个页签，已暂停；请编辑并选定一个。`);
        candidates = [];
      }
    }
    if (candidates.length === 1) {
      let current;
      try { current = await api.tabs.get(candidates[0].id); } catch { current = null; }
      if (!current || !matchesTarget(rule.target, current.pendingUrl ?? current.url)) {
        result(rule, 'changed', '执行前目标已变化，本次未刷新。');
      } else if (current.status === 'loading') {
        result(rule, 'busy', '页面正在加载，本次跳过，不叠加刷新。');
      } else {
        result(rule, 'requesting', '正在发送刷新请求。');
        await writeRules(rules);
        try {
          await api.tabs.reload(current.id, { bypassCache: rule.action === 'hard' });
          result(rule, 'sent', '已发送刷新请求；页面加载与登录状态未验证。');
          rule.state = rule.enabled ? 'ready' : 'paused';
        } catch {
          result(rule, 'error', '刷新请求失败；未重试，将按当前启停状态等待。');
        }
      }
    }
    // Chrome 周期闹钟休眠后最多触发一次；处理结束后重排下一次，不追赶遗漏轮次。
    await schedule(rule);
    await writeBindings(bindings);
    await writeRules(rules);
    return snapshot();
  }
  async function run(id, source = 'manual', alarm) {
    await ready;
    if (pending.has(id)) return { skipped: 'busy' };
    pending.add(id);
    try { return await serial(() => execute(id, source, alarm)); }
    finally { pending.delete(id); }
  }
  return {
    ready,
    async message(message) {
      await ready;
      if (message.type === 'run') return run(message.id);
      return serial(async () => {
        if (message.type === 'snapshot') return snapshot();
        if (message.type === 'save') return save(message.draft);
        if (message.type === 'toggle') return toggle(message.id, message.enabled);
        if (message.type === 'remove') return remove(message.id);
        throw new Error('不支持此操作。');
      });
    },
    onAlarm(alarm) {
      if (!alarm.name.startsWith(ALARM_PREFIX)) return Promise.resolve();
      return run(alarm.name.slice(ALARM_PREFIX.length).split('/')[0], 'alarm', alarm);
    },
    async onRemoved(tabId) {
      await ready;
      return serial(async () => {
        const rules = await readRules();
        const bindings = await readBindings();
        for (const rule of rules) if (bindings[rule.id]?.tabId === tabId) {
          delete bindings[rule.id];
          rule.enabled = false;
          rule.state = 'closed';
          result(rule, 'closed', '目标页签已关闭，定时已暂停。');
          await schedule(rule);
        }
        await writeBindings(bindings);
        await writeRules(rules);
      });
    },
  };
}
