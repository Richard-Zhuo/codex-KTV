// Phase 1：localStorage 持久化边界（唯一读写账本 key 的模块）。
// 数据安全策略（对应审计报告 Bug #8 的重构前置要求）：
// - 载入失败（JSON 损坏 / 结构非法）时先原文备份到独立 key，再进入新练习；
//   绝不在失败后直接把新状态写回原 key 覆盖原始数据。
// - save 失败（配额等）时抛错且不改变原 key 内容。
// 载入链与原 app.js 行为一致：JSON.parse → 结构校验 → 启动补值 →
// migrateDemoState → 身份归一化；仅失败分支从「静默覆盖风险」改为
// 「备份 + 新练习」，这是审计报告第 13/14 节明确要求的安全策略调整，
// 不改变任何正常路径下的业务行为。
import { initialState } from './rules.js';
import { validateDemoState, migrateStartupState, migrateDemoState, normalizeDemoUser } from './migrations.js';

export const DEMO_STATE_KEY = 'jbhh-demo-v1';
export const DEMO_BACKUP_KEY = 'jbhh-demo-v1-recovery';

const storageLike = storage => {
  if (!storage) return null;
  if (storage instanceof Map || typeof storage.get === 'function' && typeof storage.set === 'function') {
    return { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } };
  }
  if (typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
    return { getItem: key => storage.getItem(key), setItem: (key, value) => storage.setItem(key, value) };
  }
  return null;
};

export function createDemoPersistence({ storage: rawStorage } = {}) {
  const storage = storageLike(rawStorage) || storageLike(typeof localStorage === 'undefined' ? null : localStorage);
  if (!storage) throw Error('persistence 需要可用的 localStorage 存储');

  const readRaw = () => {
    try { return storage.getItem(DEMO_STATE_KEY); }
    catch { throw Error('本机存储不可用'); }
  };

  // 载入并迁移；返回 { state, recovered, problem, rawBackup }。
  // recovered=false 表示原文无法恢复，已备份并回落初始状态。
  const load = () => {
    let raw;
    try { raw = readRaw(); }
    catch { return { state: initialState(), recovered: false, problem: '本机存储不可用，已进入新练习。' }; }
    if (!raw) {
      const state = normalizeDemoUser(migrateDemoState(migrateStartupState(initialState())));
      return { state, recovered: true, problem: '' };
    }
    try {
      let state = JSON.parse(raw);
      validateDemoState(state);
      state = normalizeDemoUser(migrateDemoState(migrateStartupState(state)));
      return { state, recovered: true, problem: '' };
    } catch {
      // 失败不覆盖：先把原文搬到恢复 key（尽力而为），原 key 保持原样，
      // 页面进入新练习状态；之后任何 save 都会覆盖原 key——因此恢复
      // key 里的备份是原始数据唯一的取证副本。
      let problem = '本机练习记录无法读取，已进入新练习。';
      try {
        storage.setItem(DEMO_BACKUP_KEY, raw);
        problem += '原始记录已保留在浏览器存储（jbhh-demo-v1-recovery）。';
      } catch { problem += '原始记录备份失败。'; }
      return { state: initialState(), recovered: false, problem };
    }
  };

  // 保存下一个状态；写失败抛业务错误，原 key 不变。
  const save = next => {
    try { storage.setItem(DEMO_STATE_KEY, JSON.stringify(next)); }
    catch { throw Error('本机保存失败，操作未完成。请检查浏览器存储空间后重试。'); }
  };

  // 跨标签页读取另一标签页写入的新值（原 app.js storage 事件的等价链路）。
  const loadExternal = raw => {
    try {
      let state = raw ? JSON.parse(raw) : initialState();
      if (raw) validateDemoState(state);
      state = normalizeDemoUser(migrateDemoState(migrateStartupState(state)));
      return state;
    } catch { throw Error('读取其他标签页记录失败，请刷新'); }
  };

  return { load, save, loadExternal, key: DEMO_STATE_KEY, backupKey: DEMO_BACKUP_KEY };
}
