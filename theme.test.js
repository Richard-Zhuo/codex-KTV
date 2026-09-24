import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./theme.js', import.meta.url), 'utf8');
const key = 'jbhh-appearance-v1';
const localTime = (hour, minute = 0, second = 0) => new Date(2026, 8, 21, hour, minute, second).getTime();

function page({ time = localTime(20), saved, storageBlocked = false } = {}) {
  let clock = time, nextTimer = 0;
  const storage = new Map(saved === undefined ? [] : [[key, saved]]);
  const timers = new Map(), windowEvents = new Map(), documentEvents = new Map();
  const themeColor = {};
  const document = {
    documentElement: { dataset: {} }, hidden: false,
    querySelector: () => ({ setAttribute: (name, value) => { themeColor[name] = value; } }),
    addEventListener: (name, listener) => documentEvents.set(name, listener)
  };
  const window = {
    addEventListener: (name, listener) => windowEvents.set(name, listener),
    dispatchEvent: event => windowEvents.get(event.type)?.(event)
  };
  runInNewContext(source, {
    document, window,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } },
    CustomEvent: class { constructor(type) { this.type = type; } },
    localStorage: {
      getItem: name => { if (storageBlocked) throw new Error('storage unavailable'); return storage.get(name) ?? null; },
      setItem: (name, value) => { if (storageBlocked) throw new Error('storage unavailable'); storage.set(name, value); }
    },
    setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id)
  });
  return {
    controller: window.ktvAppearance, document, storage, timers, themeColor,
    at: time => { clock = time; },
    event: (name, event = {}) => windowEvents.get(name)?.(event),
    visibility: hidden => { document.hidden = hidden; documentEvents.get('visibilitychange')(); },
    tick: () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); }
  };
}

test('自动配色只在设备时间14:00至18:00使用日间，跨边界立即更新', () => {
  for (const [hour, minute, second, expected] of [
    [0, 0, 0, 'dark'], [6, 0, 0, 'dark'], [13, 59, 59, 'dark'],
    [14, 0, 0, 'light'], [17, 59, 59, 'light'], [18, 0, 0, 'dark'], [23, 59, 59, 'dark']
  ]) {
    const current = page({ time: localTime(hour, minute, second) });
    assert.equal(current.controller.theme, expected);
    assert.equal(current.controller.preference, 'auto');
    assert.equal(current.themeColor.content, expected === 'dark' ? '#141210' : '#f6f7f3');
  }
  for (const [hour, expected] of [[14, 'light'], [18, 'dark']]) {
    const current = page({ time: localTime(hour - 1, 59, 59) });
    assert.equal([...current.timers.values()][0].delay, 1000);
    current.at(localTime(hour));
    current.tick();
    assert.equal(current.controller.theme, expected);
    assert.equal(current.timers.size, 1);
  }
});

test('手动配色跨时段和刷新保持，恢复自动按当前设备时间生效', () => {
  const current = page();
  assert.equal(current.controller.setPreference('light'), true);
  assert.equal(current.controller.theme, 'light');
  assert.equal(current.timers.size, 0);
  assert.equal(current.storage.get(key), 'light');
  assert.equal(page({ saved: current.storage.get(key) }).controller.theme, 'light');
  current.at(localTime(2));
  current.event('focus');
  assert.equal(current.controller.theme, 'light');
  current.controller.setPreference('auto');
  assert.equal(current.controller.theme, 'dark');
  current.at(localTime(15));
  current.event('focus');
  assert.equal(current.controller.theme, 'light');
  current.controller.setPreference('dark');
  assert.equal(page({ time: localTime(15), saved: current.storage.get(key) }).controller.theme, 'dark');
  current.controller.setPreference('auto');
  assert.equal(current.controller.theme, 'light');
});

test('页面恢复前台和其他标签页修改偏好时同步，业务数据变化不影响主题', () => {
  const current = page({ time: localTime(17) });
  current.at(localTime(19));
  current.visibility(true);
  assert.equal(current.controller.theme, 'light');
  current.visibility(false);
  assert.equal(current.controller.theme, 'dark');
  current.event('storage', { key, newValue: 'light' });
  assert.equal(current.controller.theme, 'light');
  current.event('storage', { key: 'jbhh-demo-v1', newValue: '{}' });
  assert.equal(current.controller.preference, 'light');
  current.event('storage', { key: null, newValue: null });
  assert.equal(current.controller.preference, 'auto');
  assert.equal(current.controller.theme, 'dark');
});

test('损坏偏好或浏览器禁用存储时仍能自动配色和手动切换', () => {
  const invalid = page({ time: localTime(15), saved: 'broken' });
  assert.equal(invalid.controller.preference, 'auto');
  assert.equal(invalid.controller.theme, 'light');
  const blocked = page({ storageBlocked: true });
  assert.equal(blocked.controller.theme, 'dark');
  assert.equal(blocked.controller.setPreference('light'), false);
  assert.equal(blocked.controller.theme, 'light');
  assert.equal(blocked.controller.preference, 'light');
});
