/**
 * harness.mjs — headless smoke test + screenshot generator.
 *
 *   node tools/harness.mjs [--seconds 90] [--shots out/dir]
 *
 * Boots the real game against the software canvas, plays it with a simple
 * autopilot (it tracks the ball and fires the gravity flip), then writes PNGs
 * of the menu, mid-game, the flip, level clear and game over.
 *
 * This is what lets the game be developed — and its physics regressions caught
 * — without a browser in the sandbox.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const SECONDS = parseFloat(arg('--seconds', '75'));
const SHOT_DIR = arg('--shots', 'out/shots');
const VERBOSE = argv.includes('--verbose');
const DEATH_TEST = argv.includes('--death-test');
let dyingStarted = false;

const { installCanvasMock, writePng, writePngCrop } = await import('./canvas-mock.mjs');
const env = installCanvasMock({ width: 1000, height: 760, dpr: 1, rasterScale: 0.72, verboseWarnings: true });

await import('../src/main.js');
const G = globalThis.GRAVITY_BALL;
if (!G) throw new Error('game did not boot');

fs.mkdirSync(SHOT_DIR, { recursive: true });

// --------------------------------------------------------------- autopilot ---
const ai = {
  on: true,
  t: 0,
  jitter: 0,
  shots: new Map(),
  actions: { launches: 0, flips: 0, restarts: 0 },
  lastState: null,
  stateLog: [],
};

function autopilot(dt) {
  const { world, input } = G;
  ai.t += dt;
  if (world.state !== ai.lastState) {
    ai.stateLog.push(`${ai.t.toFixed(2)}s ${ai.lastState} -> ${world.state}`);
    ai.lastState = world.state;
  }
  if (!ai.on || autopilotPaused) return;

  const ball = world.main;
  const px = world.paddle.x;

  if (world.state === 'menu') {
    if (ai.t > 1.2) { env.tap(500, 300); ai.actions.restarts++; }
    return;
  }

  // Track the ball like a decent human: aim at where the ball will land.
  let target = ball ? ball.x : px;
  if (ball && ball.vy > 0) {
    // very rough lead: ball drifts with gravity, so aim a bit ahead
    target += ball.vx * 0.16;
  }
  ai.jitter = Math.sin(ai.t * 7.3) * 6;
  target = Math.max(30, Math.min(970, target + ai.jitter));
  env.pointer('pointermove', target, 640);

  if (world.state === 'ready' && world.stateT > 0.45) {
    env.tap(target, 640);
    ai.actions.launches++;
  }
  if (world.state === 'gameover' && world.stateT > 1.1) {
    env.tap(500, 400);
    ai.actions.restarts++;
  }
  // Fire the flip whenever it is charged, but not instantly every time.
  if (world.state === 'play' && world.flipReady && ai.t - (ai.lastFlip ?? -9) > 1.6) {
    ai.lastFlip = ai.t;
    env.tap(target, 400);
    ai.actions.flips++;
  }
}

// ------------------------------------------------------------------ runner ---
const FDT = 1 / 60;
let simTime = 0;
const marks = [];
const errors = [];

function safeStep(n = 1, raster = true) {
  env.setRasterize(raster);
  for (let i = 0; i < n; i++) {
    autopilot(FDT);
    try {
      env.step(FDT + (Math.random() - 0.5) * 0.002);
    } catch (e) {
      errors.push(`t=${simTime.toFixed(2)}: ${e.stack ?? e}`);
      throw e;
    }
    simTime += FDT;
  }
}

/** Crop region is given in *virtual* game coordinates (as used everywhere else). */
function crop(name, x, y, w, h, zoom = 2) {
  autopilotPaused = true;
  env.setRasterize(true);
  safeStep(1, true);
  autopilotPaused = false;
  const { RW, RH, RS } = env.size;
  const file = path.join(SHOT_DIR, `${name}.png`);
  writePngCrop(file, env.buf, RW, RH, { x: x * RS, y: y * RS, w: w * RS, h: h * RS }, zoom, fs);
  marks.push(file);
  return file;
}

function shot(name) {
  // Always paint a fresh frame with rasterization on: earlier frames may have
  // been simulated without rasterizing (much faster). The autopilot is muted
  // for the captured frame so it cannot tap anything by accident.
  autopilotPaused = true;
  env.setRasterize(true);
  safeStep(1, true);
  autopilotPaused = false;
  const { W, H, RW, RH, RS } = env.size;
  void W; void H;
  const file = path.join(SHOT_DIR, `${name}.png`);
  writePng(file, env.buf, RW, RH, fs);
  marks.push(file);
  return file;
}

let autopilotPaused = false;

function status(label) {
  const { world } = G;
  const b = world.main;
  console.log(
    `[${simTime.toFixed(1)}s] ${label.padEnd(16)} state=${world.state.padEnd(8)}`
    + ` score=${String(world.score).padStart(7)} lives=${world.lives} level=${world.levelIndex}`
    + ` bricks=${world.level.alive}/${world.level.total} chain=${world.chain} x${world.multiplier}`
    + ` balls=${world.balls.length} speed=${b ? Math.round(Math.hypot(b.vx, b.vy)) : 0}`
    + ` particles=${G.particles.live} fps=${G.fps.toFixed(0)}`,
  );
}

// ------------------------------------------------------------------- script ---
console.log('=== GRAVITY BALL headless harness ===');
safeStep(60, false);                       // ~1s of attract mode
status('menu');
shot('01-menu');

// Play until something interesting happens, grabbing action shots on the way.
let shotFlip = false, shotPlay = false, shotClear = false, shotOver = false;
const target = Math.round(SECONDS / FDT);

for (let i = 0; i < target; i++) {
  safeStep(1, false);
  const w = G.world;

  if (!shotPlay && w.state === 'play' && w.chain >= 4) {
    shotPlay = true; shot('02-chaos'); status('combat');
    crop('02b-ball-closeup', 420, 120, 360, 170);
    crop('02c-paddle-closeup', 240, 560, 420, 130);
  }
  if (!shotFlip && w.flip.active) { shotFlip = true; shot('03-gravity-flip'); status('flip'); }
  if (!shotClear && w.state === 'clear') { shotClear = true; safeStep(18, true); shot('04-level-clear'); status('clear'); }
  if (!shotOver && w.state === 'gameover') { shotOver = true; safeStep(40, true); shot('05-game-over'); status('gameover'); }
  if (DEATH_TEST && simTime > 25 && !dyingStarted && w.state === 'play') { dyingStarted = true; ai.on = false; }
  if (DEATH_TEST && dyingStarted && w.state === 'play') { ai.on = false; }
}

status('final');
shot('06-final');
crop('06b-hud-top', 0, 0, 600, 70, 2);
crop('06c-hud-foot', 0, 675, 640, 85, 2);

// ---------------------------------------------------------------- diagnostics ---
console.log('\n--- state timeline ---');
console.log(ai.stateLog.join('\n'));
console.log('\n--- autopilot ---', JSON.stringify(ai.actions));
console.log('--- audit ---');
console.log('unsupported canvas APIs used:', [...env.audit.unsupported].join(', ') || 'none');
console.log('missing context properties:', [...env.audit.missing].join(', ') || 'none');
console.log('clip() calls:', env.audit.clipCount);
console.log('warnings:', env.warnings.length ? env.warnings.join(' | ') : 'none');
console.log('\nscreenshots:\n' + marks.join('\n'));
if (errors.length) {
  console.error('\nERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nOK — no exceptions over', simTime.toFixed(1), 'simulated seconds');
process.exit(0);
