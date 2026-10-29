import test from 'node:test';
import assert from 'node:assert/strict';
import { addressTarget, matchesTarget, validateDraft, DATA_KEY, ALARM_PREFIX } from '../core.mjs';
import { createEngine } from '../engine.mjs';

function fixture() {
  let time = 1000000;
  let counter = 0;
  const local = {};
  const session = {};
  const alarms = new Map();
  const tabs = new Map([[7, { id: 7, windowId: 1, title: '测试页面', url: 'https://example.test/dashboard', status: 'complete' }]]);
  const reloads = [];
  const area = data => ({
    get: async key => structuredClone({ [key]: data[key] }),
    set: async values => { Object.assign(data, structuredClone(values)); },
  });
  const api = {
    storage: { local: area(local), session: area(session) },
    alarms: {
      getAll: async () => structuredClone([...alarms.values()]),
      create: async (name, options) => { alarms.set(name, { name, scheduledTime: options.when, periodInMinutes: options.periodInMinutes }); },
      clear: async name => alarms.delete(name),
    },
    tabs: {
      query: async () => structuredClone([...tabs.values()]),
      get: async id => { if (!tabs.has(id)) throw new Error('No tab'); return structuredClone(tabs.get(id)); },
      reload: async (id, options) => { reloads.push({ id, ...options }); },
    },
  };
  const create = () => createEngine(api, { now: () => time, newId: () => `id-${++counter}` });
  const engine = create();
  const draft = { name: '测试条目', mode: 'tab', tabId: 7, action: 'normal', minutes: 5 };
  const save = async (values = {}) => (await engine.message({ type: 'save', draft: { ...draft, ...values } })).rules.at(-1);
  return { api, engine, create, local, session, alarms, tabs, reloads, save, setTime: value => { time = value; }, time: () => time };
}

test('网站与页面匹配边界：协议、域名、路径、查询参数及片段', () => {
  const target = addressTarget('example.test');
  assert.equal(target.url, 'https://example.test/');
  assert.equal(target.match, 'site');
  assert.ok(matchesTarget(target, 'https://example.test/any/path'));
  assert.ok(!matchesTarget(target, 'https://example.test.evil.test/'));
  assert.ok(!matchesTarget(target, 'http://example.test/'));
  const page = addressTarget('https://example.test/a?x=1#section');
  assert.ok(matchesTarget(page, 'https://example.test/a?x=1#other'));
  assert.ok(!matchesTarget(page, 'https://example.test/a?x=2'));
  assert.throws(() => addressTarget('https://user:pass@example.test'), /用户名/);
  assert.throws(() => addressTarget('file:///secret'), /HTTP/);
});
test('配置校验拒绝非法名称、动作、间隔与目标方式', () => {
  const valid = { name: '刷新', minutes: 1, action: 'normal', mode: 'tab' };
  for (const invalid of [{ minutes: 0 }, { minutes: Infinity }, { minutes: 10081 }, { name: '' }, { action: 'script' }, { mode: 'all' }]) assert.throws(() => validateDraft({ ...valid, ...invalid }));
});
test('首次启动空配置；新规则默认暂停且 tabId 不写入持久配置', async () => {
  const f = fixture();
  assert.deepEqual((await f.engine.message({ type: 'snapshot' })).rules, []);
  const rule = await f.save();
  assert.equal(rule.enabled, false);
  assert.equal(f.alarms.size, 0);
  assert.equal(f.session.bindings[rule.id].tabId, 7);
  assert.ok(!JSON.stringify(f.local).includes('tabId'));
});
test('暂停状态可执行一次；普通刷新、强制刷新分别传入 bypassCache', async () => {
  const f = fixture();
  const rule = await f.save();
  await f.engine.message({ type: 'run', id: rule.id });
  await f.engine.message({ type: 'save', draft: { id: rule.id, name: '强刷', mode: 'tab', tabId: 7, minutes: 2, action: 'hard' } });
  const state = await f.engine.message({ type: 'run', id: rule.id });
  assert.deepEqual(f.reloads, [{ id: 7, bypassCache: false }, { id: 7, bypassCache: true }]);
  assert.equal(state.rules[0].lastResult.code, 'sent');
  assert.equal(state.rules[0].enabled, false);
  assert.equal(f.alarms.size, 0);
});
test('多个同址页签：指定页签只刷新该页；地址规则拒绝全刷并暂停', async () => {
  const f = fixture();
  f.tabs.set(8, { ...f.tabs.get(7), id: 8 });
  const tabRule = await f.save();
  await f.engine.message({ type: 'run', id: tabRule.id });
  assert.equal(f.reloads.length, 1);
  assert.equal(f.reloads[0].id, 7);
  const rule = await f.save({ name: '地址规则', mode: 'address', address: 'https://example.test' });
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  const state = await f.engine.message({ type: 'run', id: rule.id });
  const ambiguous = state.rules.find(item => item.id === rule.id);
  assert.equal(ambiguous.enabled, false);
  assert.equal(ambiguous.state, 'needs_selection');
  assert.equal(ambiguous.lastResult.code, 'ambiguous');
  assert.equal(f.reloads.length, 1);
});
test('找不到地址时等待且保留定时，不创建页签', async () => {
  const f = fixture();
  const rule = await f.save({ mode: 'address', address: 'https://missing.test' });
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  const state = await f.engine.message({ type: 'run', id: rule.id });
  assert.equal(state.rules[0].state, 'waiting');
  assert.equal(state.rules[0].enabled, true);
  assert.equal(f.reloads.length, 0);
  assert.equal(f.tabs.size, 1);
  assert.equal(f.alarms.size, 1);
});
test('关闭绑定页签立即暂停并清除绑定和闹钟；同 ID 新页签不会接管', async () => {
  const f = fixture();
  const rule = await f.save();
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  f.tabs.delete(7);
  await f.engine.onRemoved(7);
  f.tabs.set(7, { id: 7, url: 'https://example.test/dashboard', status: 'complete' });
  const state = await f.engine.message({ type: 'run', id: rule.id });
  assert.equal(state.rules[0].enabled, false);
  assert.equal(f.reloads.length, 0);
  assert.equal(f.alarms.size, 0);
});
test('浏览器新会话清空 session 后，具体页签必须重新确认，即便 ID 与 URL 相同', async () => {
  const f = fixture();
  const rule = await f.save();
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  delete f.session.bindings;
  const restarted = f.create();
  const state = await restarted.message({ type: 'snapshot' });
  assert.equal(state.rules[0].enabled, false);
  assert.equal(state.rules[0].state, 'needs_confirmation');
  await assert.rejects(restarted.message({ type: 'toggle', id: rule.id, enabled: true }), /重新选择/);
  assert.equal(f.alarms.size, 0);
});
test('worker 重建保留同会话绑定、配置与未来闹钟，不主动刷新', async () => {
  const f = fixture();
  const rule = await f.save();
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  const previousAlarm = structuredClone([...f.alarms.values()][0]);
  const restored = f.create();
  const state = await restored.message({ type: 'snapshot' });
  assert.equal(state.rules[0].enabled, true);
  assert.equal(state.rules[0].boundTabId, 7);
  assert.deepEqual([...f.alarms.values()][0], previousAlarm);
  assert.equal(f.reloads.length, 0);
});
test('闹钟缺失且已过期：恢复后从现在等待一个间隔，不补刷', async () => {
  const f = fixture();
  const rule = await f.save({ mode: 'address', address: 'https://example.test' });
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  f.alarms.clear();
  f.setTime(f.time() + 3600000);
  const restored = f.create();
  await restored.ready;
  assert.equal([...f.alarms.values()][0].scheduledTime, f.time() + 5 * 60000);
  assert.equal(f.reloads.length, 0);
});
test('休眠迟到的闹钟最多执行一次；重复投递忽略；下一轮从当前时间计算', async () => {
  const f = fixture();
  const rule = await f.save();
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  const alarm = structuredClone([...f.alarms.values()][0]);
  f.setTime(alarm.scheduledTime + 3600000);
  await f.engine.onAlarm(alarm);
  await f.engine.onAlarm(alarm);
  assert.equal(f.reloads.length, 1);
  assert.equal([...f.alarms.values()][0].scheduledTime, f.time() + 300000);
});
test('worker 由闹钟唤醒时即便初始闹钟已丢失，也不会吞掉该次投递', async () => {
  const f = fixture();
  const rule = await f.save();
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  const alarm = structuredClone([...f.alarms.values()][0]);
  f.alarms.clear();
  f.setTime(alarm.scheduledTime + 10);
  const restored = f.create();
  await restored.onAlarm(alarm);
  assert.equal(f.reloads.length, 1);
});
test('暂停再启用后，旧代次闹钟投递不能触发刷新', async () => {
  const f = fixture();
  const rule = await f.save();
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  const alarm = structuredClone([...f.alarms.values()][0]);
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: false });
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  await f.engine.onAlarm(alarm);
  assert.equal(f.reloads.length, 0);
  assert.equal(f.alarms.size, 1);
});
test('同一条目并发点击只发出一次刷新；加载中的页签不叠加刷新', async () => {
  const f = fixture();
  const rule = await f.save();
  let release;
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const block = new Promise(resolve => { release = resolve; });
  f.api.tabs.reload = async (id, options) => { f.reloads.push({ id, ...options }); enter(); await block; };
  const first = f.engine.message({ type: 'run', id: rule.id });
  await entered;
  assert.equal((await f.engine.message({ type: 'run', id: rule.id })).skipped, 'busy');
  release();
  await first;
  f.tabs.get(7).status = 'loading';
  const state = await f.engine.message({ type: 'run', id: rule.id });
  assert.equal(state.rules[0].lastResult.code, 'busy');
  assert.equal(f.reloads.length, 1);
});
test('页签跳转后暂停；特殊页面和无痕页签不能绑定', async () => {
  const f = fixture();
  const rule = await f.save();
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  f.tabs.get(7).url = 'https://other.test/';
  const state = await f.engine.message({ type: 'run', id: rule.id });
  assert.equal(state.rules[0].state, 'needs_confirmation');
  assert.equal(state.rules[0].enabled, false);
  assert.equal(f.reloads.length, 0);
  f.tabs.get(7).incognito = true;
  await assert.rejects(f.save(), /不支持/);
  f.tabs.get(7).incognito = false;
  f.tabs.get(7).url = 'chrome://extensions';
  await assert.rejects(f.save(), /不支持/);
});
test('执行 API 失败只记录一次结果，不重试', async () => {
  const f = fixture();
  const rule = await f.save();
  let calls = 0;
  f.api.tabs.reload = async () => { calls++; throw new Error('blocked'); };
  const state = await f.engine.message({ type: 'run', id: rule.id });
  assert.equal(state.rules[0].lastResult.code, 'error');
  assert.equal(calls, 1);
});
test('编辑暂停定时，删除清除配置、会话绑定与闹钟', async () => {
  const f = fixture();
  const rule = await f.save();
  await f.engine.message({ type: 'toggle', id: rule.id, enabled: true });
  await f.save({ id: rule.id, name: '改名' });
  assert.equal(f.alarms.size, 0);
  const state = await f.engine.message({ type: 'remove', id: rule.id });
  assert.equal(state.rules.length, 0);
  assert.deepEqual(f.session.bindings, {});
  assert.equal(f.alarms.size, 0);
});
test('不支持的持久化版本拒绝读取，不覆盖原数据', async () => {
  const f = fixture();
  await f.engine.ready;
  f.local[DATA_KEY] = { version: 2, rules: [] };
  const next = f.create();
  await assert.rejects(next.ready, /不受支持/);
  assert.equal(f.local[DATA_KEY].version, 2);
});
test('中断的执行只标记为中断，不重新发送；孤立闹钟清理', async () => {
  const f = fixture();
  const rule = await f.save();
  f.local[DATA_KEY].rules[0].lastResult = { code: 'requesting', at: f.time() };
  f.alarms.set(ALARM_PREFIX + 'deleted/token', { name: ALARM_PREFIX + 'deleted/token', scheduledTime: f.time() });
  const restored = f.create();
  const state = await restored.message({ type: 'snapshot' });
  assert.equal(state.rules[0].lastResult.code, 'interrupted');
  assert.equal(f.reloads.length, 0);
  assert.equal(f.alarms.size, 0);
});
