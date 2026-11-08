// On-screen controls for phones and tablets: player 1's pad from touches, merged into what main.js
// writes for the game (the gamepad's buttons and sticks, keyboard.c's places). A stick on the left
// (the left stick: steering and leaning; in the menus it also gives the d-pad, as the arrow keys
// do), Cross/Circle/Square/Triangle on the right, L1/L2 and R1/R2 at the top corners, SELECT and
// START between them, L3 (powerslide) and R3 (sprint) beside the face buttons, and a menu button
// for the page's menu (no ` key on a phone). A finger slides from one button to the next, several
// fingers at once, as on a pad. Shown on a touch screen by itself (the first touch), hidden again
// with a gamepad, and switched in the page menu.
const P = { SELECT: 1, L3: 2, R3: 4, START: 8, UP: 16, RIGHT: 32, DOWN: 64, LEFT: 128, L2: 256, R2: 512, L1: 1024,
  R1: 2048, TRIANGLE: 4096, CIRCLE: 8192, CROSS: 16384, SQUARE: 32768 };
const LAYOUT = [  // [label, bit, class]
  ['L2', P.L2, 'sh l2'], ['L1', P.L1, 'sh l1'], ['R2', P.R2, 'sh r2'], ['R1', P.R1, 'sh r1'],
  ['SELECT', P.SELECT, 'mid sel'], ['START', P.START, 'mid sta'],
  ['△', P.TRIANGLE, 'face tri'], ['○', P.CIRCLE, 'face cir'], ['✕', P.CROSS, 'face crs'], ['□', P.SQUARE, 'face sqr'],
  ['L3', P.L3, 'small l3'], ['R3', P.R3, 'small r3'],
];

export function createTouch({ onMenu }) {
  const root = document.createElement('div');
  root.id = 'touch'; root.hidden = true;
  const stick = document.createElement('div'), knob = document.createElement('div');
  stick.className = 'stick'; knob.className = 'knob'; stick.append(knob); root.append(stick);
  for (const [label, bit, cls] of LAYOUT) {
    const b = document.createElement('div');
    b.className = 'tb ' + cls; b.textContent = label; b.dataset.bit = bit; root.append(b);
  }
  const menu = document.createElement('div');
  menu.className = 'tb menu-btn'; menu.textContent = '☰'; menu.dataset.menu = '1'; root.append(menu);
  document.body.append(root);

  const state = { buttons: 0, lx: 128, ly: 128, stick: false };
  const fingers = new Map();  // pointerId -> { stick: true, cx, cy } | { bit }
  let pressed = 0;

  function moveStick(f, x, y) {
    const r = stick.getBoundingClientRect(), radius = r.width / 2;
    let dx = (x - f.cx) / radius, dy = (y - f.cy) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    state.lx = Math.round(128 + dx * 127); state.ly = Math.round(128 + dy * 127); state.stick = true;
    knob.style.transform = `translate(${dx * radius * 0.6}px, ${dy * radius * 0.6}px)`;
  }
  function buttonAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && root.contains(el) && el.dataset.bit ? Number(el.dataset.bit) : 0;
  }
  function update() {
    let b = 0;
    for (const f of fingers.values()) if (f.bit) b |= f.bit;
    if (b & ~pressed) navigator.vibrate?.(8);
    pressed = b; state.buttons = b;
    for (const el of root.querySelectorAll('.tb[data-bit]')) el.classList.toggle('on', !!(b & Number(el.dataset.bit)));
  }
  root.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    if (e.target.dataset?.menu) { onMenu(); return; }
    root.setPointerCapture(e.pointerId);
    if (e.target === stick || e.target === knob) {
      const r = stick.getBoundingClientRect(), f = { stick: true, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      fingers.set(e.pointerId, f); stick.classList.add('on'); moveStick(f, e.clientX, e.clientY);
    } else fingers.set(e.pointerId, { bit: buttonAt(e.clientX, e.clientY) });
    update();
  });
  root.addEventListener('pointermove', e => {
    const f = fingers.get(e.pointerId); if (!f) return;
    if (f.stick) moveStick(f, e.clientX, e.clientY);
    else { const bit = buttonAt(e.clientX, e.clientY); if (bit !== f.bit) { f.bit = bit; update(); } }
  });
  const lift = e => {
    const f = fingers.get(e.pointerId); if (!f) return;
    fingers.delete(e.pointerId);
    if (f.stick) { state.lx = state.ly = 128; state.stick = false; knob.style.transform = ''; stick.classList.remove('on'); }
    update();
  };
  root.addEventListener('pointerup', lift); root.addEventListener('pointercancel', lift);
  root.addEventListener('contextmenu', e => e.preventDefault());

  let enabled = false, autoOff = false;
  const show = on => { enabled = on; root.hidden = !on; if (!on) { fingers.clear(); state.lx = state.ly = 128; state.stick = false; update(); } };
  // a touch screen shows them at its first touch (a mouse never does)
  addEventListener('pointerdown', e => { if (e.pointerType === 'touch' && !enabled && !autoOff) show(true); }, { capture: true });
  return {
    get enabled() { return enabled; },
    set(on) { autoOff = !on; show(on); },
    // a phone or tablet: a coarse pointer and no hover (a touchscreen laptop has its mouse or pad too)
    likely: () => matchMedia('(pointer: coarse) and (hover: none)').matches,
    // player 1's pad with the touches in it: buttons |= the touched ones; the stick wins while held.
    // riding: no d-pad from the stick (the keyboard's rule: while riding the arrows are the stick only)
    merge(o, riding) {
      if (!enabled) return false;
      let b = state.buttons;
      if (state.stick && !riding) {
        if (state.lx < 64) b |= P.LEFT; else if (state.lx > 192) b |= P.RIGHT;
        if (state.ly < 64) b |= P.UP; else if (state.ly > 192) b |= P.DOWN;
      }
      o.buttons |= b;
      if (state.stick) { o.lx = state.lx; o.ly = state.ly; }
      return true;
    },
  };
}
