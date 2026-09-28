// localStorage 持久化边界：异常主记录保持原样，所有保存停写。
// 可解析的旧记录先在内存副本上迁移，套餐价不一致时仍能只读核对历史订单和付款；
// 不可解析的原文可查看，但不进入可保存的全新练习。独立备份不会覆盖已有不同备份。
// 只有主记录经修正后重新载入且完整校验通过，才解除停写；正常路径仍沿用迁移链。
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
  let recovery = null;

  // 失败时原 key 不动；恢复 key 只在空置或内容相同时使用，避免覆盖更早的备份。
  const stopWriting = (raw, state, readable, reason) => {
    raw ??= recovery?.raw ?? null; // 读权限后来失效时仍可查看本会话已取得的原文。
    let backupSaved = false;
    let backupMessage = '';
    if (raw !== null) {
      try {
        const existing = storage.getItem(DEMO_BACKUP_KEY);
        if (existing === null) storage.setItem(DEMO_BACKUP_KEY, raw);
        if (existing === null || existing === raw) backupSaved = true;
        else backupMessage = '已有另一份备份，未覆盖它。';
      } catch { backupMessage = '独立备份失败。'; }
    }
    const problem = `${reason}，已停止写入。${backupSaved ? '原文另存了恢复副本。' : backupMessage}${raw === null ? '暂时无法读取原始主记录。' : '原始主记录保持原样。'}`;
    recovery = { raw, state, readable, backupSaved, problem, key: DEMO_STATE_KEY, backupKey: DEMO_BACKUP_KEY };
    return { state, recovered: false, readOnly: true, problem };
  };

  const loadRaw = raw => {
    if (raw === null) {
      if (recovery) {
        const problem = '原始主记录已缺失，已停止写入。请先恢复并核对主记录，再重新检查。';
        recovery = { ...recovery, problem };
        return { state: recovery.state, recovered: false, readOnly: true, problem };
      }
      const state = normalizeDemoUser(migrateDemoState(migrateStartupState(initialState())));
      return { state, recovered: true, readOnly: false, problem: '' };
    }
    let preview = initialState();
    let readable = false;
    try {
      const parsed = JSON.parse(raw);
      // 先校验结构、再在内存副本上迁移；旧套餐金额异常也要能查看订单与付款。
      validateDemoState(parsed, { checkPackagePrices: false });
      preview = normalizeDemoUser(migrateDemoState(migrateStartupState(parsed)));
      readable = true;
      validateDemoState(preview);
      recovery = null;
      return { state: preview, recovered: true, readOnly: false, problem: '' };
    } catch (error) {
      const reason = readable && /套餐.*价格不一致/.test(String(error?.message))
        ? '已有套餐价格不一致，历史记录仅供核对'
        : '本机练习记录无法安全读取';
      return stopWriting(raw, preview, readable, reason);
    }
  };

  const load = () => {
    let raw;
    try { raw = storage.getItem(DEMO_STATE_KEY); }
    catch { return stopWriting(null, recovery?.state ?? initialState(), recovery?.readable ?? false, '本机存储不可用'); }
    return loadRaw(raw);
  };

  const save = next => {
    if (recovery) throw Error('原始记录异常，已停止写入。请先查看原文并修正记录，再重新检查。');
    try { storage.setItem(DEMO_STATE_KEY, JSON.stringify(next)); }
    catch { throw Error('本机保存失败，操作未完成。请检查浏览器存储空间后重试。'); }
  };

  // 跨标签页出现异常新值时也锁定本页；锁定后只能显式重新读取主记录。
  const loadExternal = raw => {
    if (recovery) throw Error('当前记录已停写，请先核对原文');
    return loadRaw(raw).state;
  };

  const isWriteBlocked = () => recovery !== null;
  const recoveryRecord = () => {
    if (!recovery) return null;
    const { state, ...record } = recovery;
    return record;
  };
  return { load, save, loadExternal, isWriteBlocked, recoveryRecord, key: DEMO_STATE_KEY, backupKey: DEMO_BACKUP_KEY };
}
