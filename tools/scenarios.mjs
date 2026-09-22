/**
 * scenarios.mjs — scripted, deterministic feature tests on the real game.
 *
 *   node tools/scenarios.mjs
 *
 * Each scenario drives the live game (the same World instance the browser
 * runs) into a specific situation — a bomb chain, a shield brick, a last-life
 * death, a 90-second physics soak — and asserts what happens. Screenshots land
 * in out/scenarios/ so the visuals can be reviewed alongside the assertions.
 *
 * The game runs against tools/canvas-mock.mjs, a software Canvas2D, so this
 * works with no browser installed.
 */
import fs from 'node:fs';
import path from 'node:path';

const { installCanvasMock, writePng, writePngCrop } = await import('./canvas-mock.mjs');
const env = installCanvasMock({ width: 1000, height: 760, dpr: 1, rasterScale: 0.72, verboseWarnings: true });

await import('../src/main.js');
const G = globalThis.GRAVITY_BALL;
const { world, particles, fx } = G;

const OUT = 'out/scenarios';
fs.mkdirSync(OUT, { recursive: true });

let passes = 0;
let failures = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) { passes++; results.push(`  ✓ ${name}`); }
  else { failures++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ------------------------------------------------------------- screenshots ---

let shots = 0;

function shot(name) {
  const { RW, RH } = env.size;
  writePng(path.join(OUT, `${name}.png`), env.buf, RW, RH, fs);
  shots++;
}

/** Close-up crop in virtual game coordinates, nearest-neighbour zoomed. */
function crop(name, x, y, w, h, zoom = 2) {
  const { RW, RH, RS } = env.size;
  writePngCrop(path.join(OUT, `${name}.png`), env.buf, RW, RH,
    { x: x * RS, y: y * RS, w: w * RS, h: h * RS }, zoom, fs);
  shots++;
}

// -------------------------------------------------------------- simulation ---

// Peaks recorded while stepping, so assertions can look at what happened
// *during* a run instead of whatever the state happens to be at the end of it.
const peak = { trauma: 0, flash: 0, particles: 0, chroma: 0, shakeX: 0 };

function resetPeaks() {
  peak.trauma = peak.flash = peak.particles = peak.chroma = peak.shakeX = 0;
}

/** Advance simulation frames (rasterizing so screenshots work at any point). */
function run(seconds, opts = {}) {
  const dt = 1 / 60;
  const n = Math.round(seconds / dt);
  env.setRasterize(opts.raster !== false);
  for (let i = 0; i < n; i++) {
    if (opts.steer !== false) {
      const b = world.main;
      if (b) env.pointer('pointermove', Math.max(20, Math.min(980, b.x + (opts.offset ?? 0))), 640);
    }
    env.step(dt);
    peak.trauma = Math.max(peak.trauma, fx.trauma);
    peak.flash = Math.max(peak.flash, fx.flash);
    peak.chroma = Math.max(peak.chroma, fx.aberration);
    peak.particles = Math.max(peak.particles, particles.live);
    peak.shakeX = Math.max(peak.shakeX, Math.abs(fx.shakeX));
  }
  env.setRasterize(true);
}

/** Force the world into the "ball is live" state without waiting for a launch. */
function goPlay() {
  world.launch();
  if (world.state !== 'play') { world.state = 'play'; world.stateT = 0.5; }
}

/** Park the ball on the paddle so no more collisions happen while timers run. */
function parkBall() {
  const b = world.main;
  b.stuck = true;
  b.vx = b.vy = 0;
  b.x = world.paddle.x;
  b.y = world.paddle.top - b.r - 2;
  world.state = 'play';
  world.balls.length = 0;
  world.balls.push(b);
}

/** Place the ball on a downward trajectory right above a brick and let it hit. */
function aimAtBrick(brick, dy = 60) {
  const b = world.main;
  b.stuck = false;
  b.x = brick.x + brick.w / 2;
  b.y = brick.y + brick.h + dy;
  b.vx = 0;
  b.vy = -520;
  world.state = 'play';
  world.flip.active = false;
}

/** Virtual game coordinate -> fake mouse client coordinate. */
function clientOf(vx, vy) {
  return G.renderer.toScreen(vx, vy);
}

// --------------------------------------------------------------- scenarios ---

function scenarioMenu() {
  world.toMenu();
  run(1.2, { steer: false });
  check('menu state', world.state === 'menu');
  check('menu starts with a full set of lives', world.lives === 3);
  shot('01-title');
}

function scenarioLaunchAndBreak() {
  world.startRun(20250922);
  world.launch();
  check('launched into play', world.state === 'play');
  check('ball is moving', Math.hypot(world.main.vx, world.main.vy) > 200);

  const brick = world.level.bricks.find((b) => b.alive && b.kind === 0);
  const before = world.score;
  resetPeaks();
  aimAtBrick(brick);
  run(0.6, { steer: false });
  check('brick destroyed by ball', !brick.alive);
  check('score increased', world.score > before, `score=${world.score}`);
  check('shrapnel emitted', peak.particles > 10, `peak=${peak.particles}`);
  check('impact shook the camera', peak.trauma > 0.05, `peak=${peak.trauma.toFixed(3)}`);
  check('impact halo registered for the bloom pass', fx.glowCount > 0);
  run(0.4, { steer: false });
  shot('02-brick-break');
}

function scenarioArmoredAndShield() {
  world.startRun(4242);
  world.startLevel(4);           // level 4 template contains shields + bombs
  goPlay();
  run(0.5, { steer: false });

  const shieldBrick = world.level.bricks.find((b) => b.alive && b.kind === 3);
  check('level 4 contains a shield brick', !!shieldBrick);
  if (shieldBrick) {
    aimAtBrick(shieldBrick);
    run(0.6, { steer: false });
    check('shield brick survives a normal hit', shieldBrick.alive && shieldBrick.hp === 1);

    // ...but an anti-gravity hit goes straight through it.
    aimAtBrick(shieldBrick);
    world.state = 'play';
    world.flip.active = true;
    world.flip.t = 1.2;
    world.gravity = -1200;
    run(0.7, { steer: false });
    check('anti-gravity shatters the shield', !shieldBrick.alive);
    world.flip.active = false;
    world.gravity = 420;
  }
  shot('03-shield-broken');
}

function scenarioBombChain() {
  world.startRun(7);
  goPlay();
  run(0.3, { steer: false });
  resetPeaks();
  const aliveBefore = world.level.bricks.filter((b) => b.alive).length;
  world._explode(500, 190, 168);
  run(0.75, { steer: false });
  const destroyed = aliveBefore - world.level.bricks.filter((b) => b.alive).length;
  check('explosion destroys a cluster', destroyed >= 4, `destroyed=${destroyed}`);
  check('explosion shook the camera hard', peak.trauma > 0.4, `peak=${peak.trauma.toFixed(3)}`);
  check('explosion flashed the screen', peak.flash > 0.1, `peak=${peak.flash.toFixed(3)}`);
  check('chain multiplier rose above 1', world.multiplier > 1, `x${world.multiplier}`);
  shot('04-bomb-chain');
}

function scenarioPowerups() {
  world.startRun(99);
  world.startLevel(2);
  goPlay();
  run(0.4, { steer: false });

  // Drop each power-up right above the paddle and catch it.
  const catchKind = (kind) => {
    const px = world.paddle.x;
    const before = {
      balls: world.balls.length, score: world.score,
      wide: world.paddle.targetW, charge: world.flip.charge,
    };
    world._spawnDrop(px, world.paddle.y - 70);
    world.drops[world.drops.length - 1].kind = kind;
    run(0.8, { steer: false });
    return {
      before,
      after: { balls: world.balls.length, score: world.score, wide: world.paddle.targetW, charge: world.flip.charge },
    };
  };

  const wide = catchKind('wide');
  check('WIDE expands the paddle', wide.after.wide > wide.before.wide, `${wide.before.wide} -> ${wide.after.wide}`);

  world.flip.charge = 0;
  catchKind('grav');
  check('FLIP+ recharges the gravity flip', world.flip.charge >= 1);

  const multi = catchKind('multi');
  check('MULTI spawns extra balls', multi.after.balls > multi.before.balls, `${multi.before.balls} -> ${multi.after.balls}`);

  const points = catchKind('points');
  check('$ pays out score', points.after.score > points.before.score, `${points.before.score} -> ${points.after.score}`);

  catchKind('slow');
  check('SLOW charges the slow-motion buff', world.buffs.slow > 0);
  shot('05-powerups');

  // Let WIDE expire and verify the paddle goes back to its base width.
  parkBall();
  run(15, { steer: false, raster: false });
  check('paddle returns to its base width after WIDE expires', world.paddle.targetW === 130, `w=${world.paddle.targetW}`);
  check('SLOW expires too', world.buffs.slow <= 0);
}

function scenarioFlip() {
  world.startRun(5);
  world.startLevel(1);
  goPlay();
  run(0.4, { steer: false });
  world.launch();
  run(0.5, { steer: false });
  const ok = world.activateFlip();
  check('flip activates when charged', ok === true);
  check('gravity inverts', world.gravity < 0, `gravity=${world.gravity}`);
  run(0.35, { steer: false });
  shot('06-gravity-flip');
  check('flip is on cooldown afterwards', world.flip.charge < 1);
  run(1.4, { steer: false });
  check('gravity returns to normal', world.gravity > 0, `gravity=${world.gravity}`);
  check('flip recharges', world.flip.charge > 0);
}

function scenarioChainAndMultiplier() {
  world.startRun(11);
  world.startLevel(1);
  goPlay();
  run(0.4, { steer: false });
  world.chain = 0;
  for (let i = 0; i < 8; i++) {
    const brick = world.level.bricks.find((b) => b.alive && b.kind === 0);
    if (!brick) break;
    world._destroyBrick(brick, brick.x + brick.w / 2, brick.y + brick.h / 2, 0, -1, 600, world.main);
    // 0.5 s apart: faster than the 3.5 s combo timeout, so the chain holds.
    run(0.5, { steer: false });
  }
  check('chain of 8 counted', world.chain === 8, `chain=${world.chain}`);
  check('multiplier reached x5', world.multiplier === 5, `x${world.multiplier}`);
  run(0.2, { steer: false });
  shot('07-chain-multiplier');

  // No hits for longer than the combo timeout -> the chain resets.
  parkBall();
  const chainAtPark = world.chain;
  run(4.2, { steer: false });
  check('chain expires after the timeout', world.chain === 0, `chain=${chainAtPark} -> ${world.chain}`);
}

function scenarioExtraLife() {
  world.startRun(3);
  const lives = world.lives;
  world.addScore(20000, 500, 300, null);
  check('extra ball awarded at 20k', world.lives === lives + 1, `lives=${world.lives}`);
  run(0.3, { steer: false });
  shot('08-extra-ball');
}

function scenarioLifeLostAndGameOver() {
  world.startRun(17);
  world.lives = 1;
  goPlay();
  run(0.5, { steer: false });
  resetPeaks();
  const b = world.main;
  b.stuck = false;
  b.x = 500;
  b.y = 655;
  b.vx = 0;
  b.vy = 700;
  run(0.25, { steer: false });
  check('losing the last ball ends the run', world.state === 'gameover', `state=${world.state}`);
  check('run stats recorded', !!world.runStats && world.runStats.score >= 0);
  check('lives at zero', world.lives === 0);
  check('death played a slow-motion hit', peak.chroma > 0.2 || peak.flash > 0.1,
    `chroma=${peak.chroma.toFixed(2)} flash=${peak.flash.toFixed(2)}`);
  run(1.4, { steer: false });
  shot('09-game-over');

  // The game must be restartable from the game over screen.
  env.pointer('pointerdown', 500, 400);
  env.pointer('pointerup', 500, 400);
  run(0.3, { steer: false });
  check('restart from game over', world.state === 'ready' && world.lives === 3,
    `state=${world.state} lives=${world.lives}`);
}

function scenarioLevelClear() {
  world.startRun(21);
  goPlay();
  run(0.4, { steer: false });
  resetPeaks();
  // Clear the field by hand and let the sim notice.
  for (const b of world.level.bricks) if (b.alive) world.level.kill(b, world);
  run(0.25, { steer: false });
  check('level clear state entered', world.state === 'clear', `state=${world.state}`);
  check('clear is a celebration (shake + flash)', peak.trauma > 0.2 && peak.flash > 0.1,
    `trauma=${peak.trauma.toFixed(2)} flash=${peak.flash.toFixed(2)}`);
  run(0.5, { steer: false });
  shot('10-level-clear');
  run(2.6, { steer: false });
  check('clear bonus awarded', world.score >= 1000, `score=${world.score}`);
  check('advanced to level 2', world.levelIndex === 2, `level=${world.levelIndex}`);
  check('fresh bricks built', world.level.alive > 20, `bricks=${world.level.alive}`);
  check('speed ramped up with the level', world.ballSpeed() > 600, `speed=${world.ballSpeed()}`);
  check('paddle survived the transition', !!world.paddle && world.paddle.w > 0);
}

function scenarioPause() {
  world.startRun(31);
  goPlay();
  run(0.4, { steer: false });
  const snap = { score: world.score, x: world.main.x, y: world.main.y };
  world.paused = true;
  run(0.8, { steer: false });
  check('paused freezes the simulation', world.score === snap.score && world.main.x === snap.x);
  shot('11-paused');
  world.paused = false;
  run(0.2, { steer: false });
  check('unpause resumes the ball', world.main.x !== snap.x || world.main.y !== snap.y);
  check('pause overlay does not break the state machine', world.state === 'play');
}

/** Layout maths + pointer/touch input at several viewport sizes. */
function scenarioLayoutAndInput() {
  world.startRun(555);
  goPlay();
  run(0.3, { steer: false });

  // ---------- 1. high-DPI desktop with a different aspect ratio ----------
  env.setViewport(2560, 1440, 2);
  run(0.15, { steer: false });
  const mid = clientOf(500, 380);
  check('letterbox: client centre maps to the virtual centre',
    Math.abs(mid.x - 1280) < 1.5 && Math.abs(mid.y - 720) < 1.5, `${mid.x.toFixed(1)},${mid.y.toFixed(1)}`);
  env.pointer('pointermove', mid.x, mid.y);
  run(0.05, { steer: false });
  check('pointer at centre puts the paddle in the middle', Math.abs(world.paddle.x - 500) < 6,
    `paddle=${world.paddle.x.toFixed(1)}`);

  const far = clientOf(995, 380);
  env.pointer('pointermove', far.x, far.y);
  run(0.6, { steer: false });
  check('paddle stops at the right wall', Math.abs(world.paddle.x - (990 - world.paddle.w / 2)) < 8,
    `paddle=${world.paddle.x.toFixed(1)} wall=${(990 - world.paddle.w / 2).toFixed(1)}`);

  const near = clientOf(5, 380);
  env.pointer('pointermove', near.x, near.y);
  run(0.6, { steer: false });
  check('paddle stops at the left wall', Math.abs(world.paddle.x - (10 + world.paddle.w / 2)) < 8,
    `paddle=${world.paddle.x.toFixed(1)}`);
  shot('19-widescreen-hidpi');

  // ---------- 2. phone landscape, touch input ----------
  env.setViewport(900, 430, 3);
  run(0.15, { steer: false });

  // a drag must NOT fire the primary action (no accidental gravity flips)
  world.flip.charge = 1;
  const start = clientOf(500, 600);
  const end = clientOf(700, 600);
  env.pointer('pointerdown', start.x, start.y, { pointerType: 'touch' });
  env.pointer('pointermove', end.x, end.y, { pointerType: 'touch' });
  env.pointer('pointerup', end.x, end.y, { pointerType: 'touch' });
  run(0.2, { steer: false });
  check('dragging the paddle does not flip gravity', !world.flip.active && world.flip.charge === 1);

  // ...but a tap does
  const tapPt = clientOf(500, 600);
  env.pointer('pointerdown', tapPt.x, tapPt.y, { pointerType: 'touch' });
  env.pointer('pointerup', tapPt.x, tapPt.y, { pointerType: 'touch' });
  run(0.2, { steer: false });
  check('tapping flips gravity', world.flip.active === true);
  run(1.6, { steer: false, raster: false });

  // The on-screen GRAVITY pad. Park a live ball first so the run is in PLAY.
  world.flip.charge = 1;
  world.flip.active = false;
  parkBall();
  const btn = clientOf(920, 720);
  env.pointer('pointerdown', btn.x, btn.y, { pointerType: 'touch' });
  env.pointer('pointerup', btn.x, btn.y, { pointerType: 'touch' });
  run(0.15, { steer: false });
  check('on-screen GRAVITY pad fires the flip', world.flip.active === true);
  run(1.6, { steer: false, raster: false });

  // ...it must not be usable while the charge is empty
  world.flip.active = false;
  world.flip.charge = 0;
  env.pointer('pointerdown', btn.x, btn.y, { pointerType: 'touch' });
  env.pointer('pointerup', btn.x, btn.y, { pointerType: 'touch' });
  run(0.15, { steer: false, raster: false });
  check('GRAVITY pad does nothing while recharging', world.flip.active === false);

  // ...and it must never launch the ball from the READY state
  world.startLevel(world.levelIndex);
  run(0.4, { steer: false, raster: false });
  check('ready state before the pad test', world.state === 'ready', `state=${world.state}`);
  env.pointer('pointerdown', btn.x, btn.y, { pointerType: 'touch' });
  env.pointer('pointerup', btn.x, btn.y, { pointerType: 'touch' });
  run(0.2, { steer: false, raster: false });
  check('GRAVITY pad never launches the ball', world.state === 'ready' && world.main.stuck === true,
    `state=${world.state}`);

  // ---------- 3. portrait: hint is drawn, game still runs ----------
  env.setViewport(430, 900, 3);
  run(0.4, { steer: false });
  check('portrait mode does not crash the renderer', G.fps >= 0);
  shot('20-portrait-hint');
  crop('21-portrait-hint-crop', 0, 300, 430, 200, 1);

  // back to the reference viewport for later scenarios
  env.setViewport(1000, 760, 1);
  run(0.2, { steer: false });
}

function scenarioVisualCloseups() {
  world.startRun(777);
  world.startLevel(3);
  goPlay();
  run(0.4, { steer: false });

  // A fast ball so trail, stretch and glow are all visible at once.
  const b = world.main;
  b.stuck = false;
  b.x = 300;
  b.y = 330;
  b.vx = 540;
  b.vy = -260;
  world.gravity = 0;
  run(0.25, { steer: false });
  crop('12-ball-closeup', b.x - 90, b.y - 60, 180, 120, 3);
  crop('13-paddle-closeup', world.paddle.x - 130, world.paddle.y - 40, 260, 80, 3);
  crop('14-brick-closeup', 320, 100, 260, 140, 2);
  crop('15-hud-foot', 0, 672, 700, 88, 2);
  crop('16-hud-top', 0, 0, 620, 70, 2);
  world.gravity = 420;

  // Reverse gravity for the flip look.
  world.flip.charge = 1;
  world.activateFlip();
  run(0.35, { steer: false });
  crop('17-ball-flipped', Math.max(60, world.main.x - 90), Math.max(60, world.main.y - 60), 180, 120, 3);

  // Multi-ball density.
  run(1.2, { steer: false, raster: false });
  world._applyDrop({ x: world.paddle.x, y: world.paddle.y - 20, kind: 'multi' });
  run(0.35, { steer: false });
  shot('18-multiball');
  check('multiball gives three balls in play', world.balls.length >= 2, `balls=${world.balls.length}`);
}

/**
 * Soak: play with deliberately erratic steering and make sure the ball can
 * never leave the arena, no matter how fast it gets or how the levels escalate.
 */
function scenarioBallNeverEscapes() {
  world.startRun(1234);
  const field = { x0: 10, y0: 80, x1: 990, y1: 670 };
  let escapes = 0;
  let maxSpeed = 0;
  world.launch();
  env.setRasterize(false);          // physics-only: no need to paint 5400 frames
  for (let i = 0; i < 60 * 90; i++) {
    const b = world.main;
    const target = b ? (Math.sin(i / 90) > 0 ? b.x + 120 : 500 - (b.x - 500)) : 500;
    env.pointer('pointermove', Math.max(20, Math.min(980, target)), 640);
    env.step(1 / 60);
    for (const ball of world.balls) {
      maxSpeed = Math.max(maxSpeed, Math.hypot(ball.vx, ball.vy));
      if (ball.dead || ball.stuck) continue;
      if (ball.x - ball.r < field.x0 - 1.5 || ball.x + ball.r > field.x1 + 1.5
        || ball.y - ball.r < field.y0 - 1.5 || ball.y > field.y1 + 4) escapes++;
    }
    if (world.state === 'menu') break;
  }
  env.setRasterize(true);
  check('ball never left the arena in 90 s of chaos play', escapes === 0, `escapes=${escapes}`);
  check('speed stayed within its cap', maxSpeed <= 1420 * 1.02 + 0.5, `maxSpeed=${maxSpeed.toFixed(1)}`);
  check('game never deadlocked', world.state !== 'menu', `state=${world.state}`);
  check('particle pool never overflowed', particles.live <= particles.max, `live=${particles.live}`);
}

// ------------------------------------------------------------------ report ---

function runAll(fn, name) {
  const before = failures;
  const t0 = Date.now();
  fn();
  const ms = Date.now() - t0;
  console.log(`\n▸ ${name} (${ms} ms)${failures > before ? '   ← FAILURES' : ''}`);
  console.log(results.splice(0, results.length).join('\n'));
}

console.log('=== GRAVITY BALL scenario tests ===');
runAll(scenarioMenu, 'title / attract mode');
runAll(scenarioLaunchAndBreak, 'launch + brick physics');
runAll(scenarioArmoredAndShield, 'armoured + shield bricks');
runAll(scenarioBombChain, 'bomb chain reaction');
runAll(scenarioPowerups, 'power-ups');
runAll(scenarioFlip, 'gravity flip');
runAll(scenarioChainAndMultiplier, 'chain multiplier');
runAll(scenarioExtraLife, 'extra ball');
runAll(scenarioLifeLostAndGameOver, 'death + game over + restart');
runAll(scenarioLevelClear, 'level clear + progression');
runAll(scenarioPause, 'pause');
runAll(scenarioLayoutAndInput, 'layout + pointer/touch input');
runAll(scenarioVisualCloseups, 'visual close-ups');
runAll(scenarioBallNeverEscapes, '90 s physics soak');

console.log('\n--- audit ---');
console.log('unsupported canvas APIs:', [...env.audit.unsupported].join(', ') || 'none');
console.log('missing context props:', [...env.audit.missing].join(', ') || 'none');
console.log('clip() calls (must stay 0):', env.audit.clipCount);
check('no invalid CSS colours reached the canvas', env.audit.invalidColors.size === 0,
  [...env.audit.invalidColors].slice(0, 6).join(' | '));
console.log('warnings:', env.warnings.length ? env.warnings.join(' | ') : 'none');
console.log(`\nscreenshots: ${shots} written to ${OUT}`);
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
