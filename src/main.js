/**
 * main.js — bootstrap, the game loop and the glue between systems.
 *
 * Loop shape:
 *   requestAnimationFrame -> fx.update (real time: shake, hitstop, slow-mo)
 *                         -> fixed 1/120 s simulation steps (physics)
 *                         -> one draw pass + CRT post-processing
 * Freeze frames and slow-motion are handled by scaling the *simulation* clock,
 * which is why the camera can keep shaking while the world holds still.
 */
import { Renderer } from './render/renderer.js';
import { Background } from './render/bg.js';
import { Hud } from './render/hud.js';
import { Particles } from './core/particles.js';
import { Fx } from './core/fx.js';
import { GameAudio } from './core/audio.js';
import { Input } from './core/input.js';
import { World, STATE } from './game/world.js';
import { makeRng } from './core/math.js';
import {
  VIEW, FIELD, TIMING, JUICE, COLORS,
  PRESETS, applyPreset, activePresetName, nextPresetName, isPreset,
} from './config.js';

// ---------------------------------------------------------------- storage ---
const store = {
  read(key, fallback) {
    try {
      const v = globalThis.localStorage?.getItem(key);
      return v === null || v === undefined ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  write(key, value) {
    try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

// ------------------------------------------------------------------ setup ---
const canvas = document.getElementById('stage');
const renderer = new Renderer(canvas);
const fx = new Fx();
const particles = new Particles(2800);
const audio = new GameAudio();
const world = new World({ fx, particles, audio, renderer });
const hud = new Hud();
const bg = new Background(makeRng(1337));
const input = new Input(canvas);

input.toVirtual = (cx, cy) => renderer.toVirtual(cx, cy);
input.onGrabX = () => world.paddle.x;
input.hitTest = (x, y, isTouch) => {
  if (!isTouch) return null;                 // desktop flips with any click anyway
  const b = Hud.flipButton;
  const dx = x - b.x, dy = y - b.y;
  return dx * dx + dy * dy <= (b.r + 10) ** 2 ? 'gravity' : null;
};
input.onFirstInput = () => {
  audio.unlock();
  audio.setLevel(world.levelIndex);
  audio.setIntensity(world.state === STATE.MENU ? 0.02 : 0.1);
};

/**
 * Respect the OS-level motion preference: shake, flashes and chromatic
 * fringes are damped to a third. Hitstop, squash, particles and every other
 * gameplay-readable cue stay exactly as they are.
 */
function applyMotionPreference() {
  let reduced = false;
  try { reduced = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch { /* old browser */ }
  fx.motionScale = reduced ? 0.35 : 1;
  return reduced;
}
applyMotionPreference();
try {
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.addEventListener?.('change', () => {
    const reduced = applyMotionPreference();
    hud.banner(reduced ? 'REDUCED MOTION ON' : 'REDUCED MOTION OFF', 'system preference', 1.2);
  });
} catch { /* Safari < 14 uses addListener; the initial read is enough */ }

/**
 * Rotate the feel preset and make the change *legible*: a banner names it, the
 * name persists, and the world re-reads the numbers immediately so the swap is
 * visible even while paused or on the title screen.
 */
function cyclePreset(dir) {
  const name = nextPresetName(dir);
  applyPreset(name);
  store.write('gb.preset', name);
  world.refreshFromConfig();
  hud.banner(PRESETS[name].label, PRESETS[name].blurb, 1.6, COLORS.accent);
}

let best = store.read('gb.best', 0) || 0;
const settings = Object.assign({ shake: true, scanlines: true, muted: false }, store.read('gb.settings', {}));

// Apply the saved feel preset before the world builds its first level, so the
// attract mode already plays at the tuning the player last chose.
const storedPreset = store.read('gb.preset', 'arcade');
applyPreset(isPreset(storedPreset) ? storedPreset : 'arcade');
fx.shakeEnabled = settings.shake;
renderer.scanlinesOn = settings.scanlines;
audio.muted = settings.muted;
hud.best = best;

world.onEvent = (name, data) => {
  switch (name) {
    case 'gameOver':
      if (data.score > best) {
        best = data.score;
        hud.best = best;
        store.write('gb.best', best);
        hud.banner('NEW BEST!', `${best.toLocaleString('en-US')} POINTS`, 2.2, COLORS.gold);
      }
      break;
    case 'extraLife':
      hud.banner('EXTRA BALL', '+1 LIFE', 1.8, COLORS.gold);
      break;
    case 'levelClear':
      hud.banner('NICE WORK', '', 1.2, COLORS.accent);
      break;
    default: break;
  }
};

world.toMenu();
hud.lastScore = 0;

// ------------------------------------------------------------------- loop ---
let last = now();
let acc = 0;
let frames = 0;
let fpsAcc = 0;
let fps = 60;
let running = true;

function now() {
  return (globalThis.performance?.now?.() ?? Date.now()) / 1000;
}

function frame() {
  if (!running) return;
  const t = now();
  let real = t - last;
  last = t;
  // Frame-time guard: after a tab switch or a hitch we do *not* want to run a
  // hundred physics steps, so clamp (and treat it as a fresh start).
  if (real > TIMING.maxFrame) real = TIMING.maxFrame;
  if (real < 0) real = 0;

  // ---- global keys
  if (input.mute) {
    audio.muted = !audio.muted;
    settings.muted = audio.muted;
    store.write('gb.settings', settings);
  }
  if (input.toggleShake) {
    fx.shakeEnabled = !fx.shakeEnabled;
    settings.shake = fx.shakeEnabled;
    store.write('gb.settings', settings);
    hud.banner(fx.shakeEnabled ? 'SHAKE ON' : 'SHAKE OFF', 'F2', 1.1);
  }
  if (input.pause && (world.state === STATE.PLAY || world.state === STATE.READY)) {
    world.paused = !world.paused;
    world.paused ? audio.duck(0.7, 0.2) : audio.duck(0, 0.2);
  }
  if (input.restart && world.state !== STATE.MENU) {
    world.paused = false;
    world.startRun();
    world.state = STATE.READY;
  }
  if (input.cyclePreset) cyclePreset(1);
  if (input.debug) debug = !debug;

  const dtV = real * fx.simScale;

  input.update(real);
  fx.update(real);

  // ---- fixed-step simulation
  if (!world.paused) {
    acc += dtV;
    let steps = 0;
    while (acc >= TIMING.fixedDt && steps < 8) {
      world.update(TIMING.fixedDt, input);
      input.endFrame();
      acc -= TIMING.fixedDt;
      steps++;
    }
    if (steps >= 8) acc = 0;
    particles.update(dtV, world.state === STATE.DYING ? 900 : 0);
  } else {
    // Paused: still let the input edges through so unpausing works next frame.
    input.endFrame();
    acc = 0;
  }

  hud.update(real, world, best);

  // ---- audio intensity follows the chain, and dips while paused
  if (!world.paused && world.state === STATE.PLAY) {
    audio.setIntensity(Math.min(1, world.chain / 16 + (world.flip.active ? 0.25 : 0)));
  }
  // ---- draw
  draw(dtV, real);

  frames++;
  fpsAcc += real;
  if (fpsAcc > 0.5) { fps = frames / fpsAcc; frames = 0; fpsAcc = 0; }

  requestAnimationFrame(frame);
}

let debug = false;

function draw(dtV, real) {
  renderer.begin(fx, { x: VIEW.w / 2, y: FIELD.y + FIELD.h / 2 });

  bg.update(dtV, { heat: Math.min(1, world.chain / 12 + (world.flip.active ? 0.5 : 0)) });
  bg.draw(renderer.ctx, {
    t: world.t,
    dir: world.flip.active ? -1 : 1,
    intensity: world.chain / 16,
    level: world.levelIndex,
    danger: world.danger,
  });

  world.draw(renderer);

  particles.drawNormal(renderer.ctx);
  particles.drawAdditive(renderer.ctx);

  renderer.beginHud();
  hud.draw(renderer, world, fx);
  hud.drawTouchButton(renderer, world, input.isTouch, world.t);
  hud.drawPortraitHint(renderer, isPortrait());

  // ---- post processing
  renderer.flash(fx.flash, fx.flashColor);
  renderer.chromatic(fx.aberration * JUICE.aberration);
  // Fade the red edge-glow in only when the ball is genuinely close to death.
  const nearDeath = clamp01((world.danger - 0.55) / 0.45);
  renderer.vignette(JUICE.vignette, nearDeath * 0.3 + (world.lives === 1 ? 0.06 : 0));
  renderer.scanlines(JUICE.scanlines);
  renderer.grain(0.02, real);

  if (debug) debugOverlay(real);
}

function debugOverlay(real) {
  const ctx = renderer.ctx;
  const lines = [
    `fps ${fps.toFixed(0)}   dt ${(real * 1000).toFixed(1)}ms`,
    `state ${world.state}${world.paused ? ' (paused)' : ''}  scale ${fx.simScale.toFixed(2)}  hitstop ${fx.hitstop.toFixed(2)}`,
    `particles ${particles.live}/${particles.max}  popups ${world.popups.length}  drops ${world.drops.length}`,
    `balls ${world.balls.length}  speed ${Math.round(world.main?.speed ?? 0)}  gravity ${Math.round(world.gravity)}`,
    `flip ${world.flip.active ? 'ACTIVE' : world.flip.charge.toFixed(2)}  chain ${world.chain} x${world.multiplier}`,
    `bricks ${world.level.alive}/${world.level.total}  score ${world.score}`,
  ];
  renderer.beginHud();
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(8, VIEW.h - 108, 470, 100);
  lines.forEach((l, i) => {
    renderer.text(l, 16, VIEW.h - 92 + i * 15, { size: 11, weight: 600, color: '#7dffb0', mono: true });
  });
  ctx.restore();
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** The arena is authored 1000x760: on a portrait window it becomes tiny, so we
 *  ask the player to rotate instead of pretending it is fine. */
function isPortrait() {
  const cw = renderer.canvas.clientWidth || 1000;
  const ch = renderer.canvas.clientHeight || 760;
  return ch > cw * 1.02;
}

// ---------------------------------------------------------------- lifecycle ---
function onResize() { renderer.resize(); }
globalThis.addEventListener?.('resize', onResize);
globalThis.addEventListener?.('orientationchange', onResize);
globalThis.document?.addEventListener?.('visibilitychange', () => {
  const hidden = globalThis.document.hidden;
  if (hidden && (world.state === STATE.PLAY || world.state === STATE.READY)) {
    world.paused = true;
    audio.duck(0.7, 0.2);
  }
});

// Expose a tiny API for debugging from the console / the test harness.
globalThis.GRAVITY_BALL = {
  world, fx, particles, audio, renderer, hud, input,
  get fps() { return fps; },
  get debug() { return debug; },
  set debug(v) { debug = !!v; },
  startRun: (seed) => world.startRun(seed),
  preset: () => activePresetName(),
  setPreset: (name) => {
    if (!applyPreset(name)) return null;
    store.write('gb.preset', name);
    world.refreshFromConfig();
    return name;
  },
  cyclePreset,
  stop() { running = false; },
};

requestAnimationFrame(frame);
