import test from 'node:test';
import assert from 'node:assert/strict';

test('room card exposes keyboard semantics and Enter/Space activate its room action', async () => {
  const originalWindow = globalThis.window;
  globalThis.window ??= { addEventListener() {} };
  let ctx;
  let beforeState;
  let beforeFormal;
  try {
    ({ ctx } = await import('./context.js'));
    const { initialState } = await import('../rules.js');
    const { activateRoomCardOnKey, roomCard } = await import('./pages/rooms.js');
    beforeState = ctx.state;
    beforeFormal = ctx.formal;
    ctx.formal = null;
    ctx.state = initialState();
    const markup = roomCard(ctx.state.rooms[0]);
    assert.match(markup, /class="room-card [^"]*"[^>]*role="button" tabindex="0"/);
    assert.match(markup, /aria-label="[^"]+"/);
    let clicks = 0;
    let prevented = 0;
    const target = {
      matches: selector => selector === '.room-card[role="button"]',
      click() { clicks += 1; }
    };
    for (const key of ['Enter', ' ']) {
      activateRoomCardOnKey({ key, target, preventDefault() { prevented += 1; } });
    }
    activateRoomCardOnKey({ key: 'Escape', target,
      preventDefault() { prevented += 1; } });
    activateRoomCardOnKey({ key: 'Enter',
      target: { matches: () => false, click() { clicks += 1; } },
      preventDefault() { prevented += 1; } });
    assert.equal(clicks, 2);
    assert.equal(prevented, 2);
  } finally {
    if (ctx) {
      ctx.state = beforeState;
      ctx.formal = beforeFormal;
    }
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
