// Input: pointer lock, mouse look, and the key set.
//
// The key set is a Set mutated in place, never rebuilt, so the fixed-step loop reads it without
// allocating. A one-shot press (jump, reload, buy) is queued once and drained by the step, so a press
// between frames is neither lost nor fired twice.
export function createInput(canvas, onLockChange) {
  const keys = new Set();
  const state = {
    keys,
    locked: false,
    firing: false,
    lookX: 0,
    lookY: 0,
    jumpQueued: false,
    pressed: null,
  };

  const GAME_KEYS = new Set([
    'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyE', 'KeyB', 'Tab',
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyG', 'Digit1', 'Digit2',
    'Digit3', 'Digit4', 'Digit5',
  ]);

  window.addEventListener('keydown', (event) => {
    if (GAME_KEYS.has(event.code)) event.preventDefault();
    if (keys.has(event.code)) return; // ignore auto-repeat
    keys.add(event.code);
    if (event.code === 'Space') state.jumpQueued = true;
    if (event.code !== 'Tab') state.pressed = event.code;
  });

  window.addEventListener('keyup', (event) => {
    keys.delete(event.code);
  });

  window.addEventListener('blur', () => {
    keys.clear();
    state.firing = false;
  });

  window.addEventListener('mousemove', (event) => {
    if (!state.locked) return;
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  });

  window.addEventListener('mousedown', (event) => {
    if (state.locked && event.button === 0) state.firing = true;
  });

  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) state.firing = false;
  });

  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      keys.clear();
      state.firing = false;
    }
    onLockChange(state.locked);
  });

  return {
    state,
    requestLock() {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
    },
    takeLook() {
      const x = state.lookX;
      const y = state.lookY;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    takeJump() {
      const jump = state.jumpQueued;
      state.jumpQueued = false;
      return jump;
    },
    takePressed() {
      const p = state.pressed;
      state.pressed = null;
      return p;
    },
  };
}
