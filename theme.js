// 在样式表前执行，避免已保存的夜间模式刷新时先闪白。
(() => {
  const key = 'jbhh-appearance-v1';
  const modes = ['auto', 'light', 'dark'];
  const root = document.documentElement;
  const normalize = value => modes.includes(value) ? value : 'auto';
  let preference = 'auto', timer;
  try { preference = normalize(localStorage.getItem(key)); } catch { /* 存储不可用时仍可在本页切换。 */ }

  const sunriseHour = 6, dayEndHour = 19;
  function refresh() {
    const now = new Date();
    const hour = now.getHours();
    const theme = preference === 'auto' ? (hour >= sunriseHour && hour < dayEndHour ? 'light' : 'dark') : preference;
    const changed = root.dataset.theme !== theme || root.dataset.themePreference !== preference;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#141210' : '#f6f7f3');
    if (changed) window.dispatchEvent(new CustomEvent('appearancechange'));

    // 到日出或19:00立即切换；每分钟复核设备时间，并在回到页面时重新核对。
    clearTimeout(timer);
    if (preference === 'auto') {
      const boundary = new Date(now);
      if (hour >= dayEndHour) boundary.setDate(boundary.getDate() + 1);
      boundary.setHours(hour >= sunriseHour && hour < dayEndHour ? dayEndHour : sunriseHour, 0, 0, 0);
      timer = setTimeout(refresh, Math.max(1, Math.min(60000, boundary - now)));
    }
  }

  window.ktvAppearance = Object.freeze({
    get preference() { return preference; },
    get theme() { return root.dataset.theme; },
    setPreference(value) {
      preference = normalize(value);
      let saved = true;
      try { localStorage.setItem(key, preference); } catch { saved = false; }
      refresh();
      return saved;
    }
  });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = normalize(event.newValue);
    refresh();
  });
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  refresh();
})();
