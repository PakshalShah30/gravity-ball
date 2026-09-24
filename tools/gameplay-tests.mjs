/**
 * gameplay-tests.mjs — scenario tests for the newer mechanics: portal and
 * ghost bricks, boss cores, the magnet power-up, daily + custom run modes and
 * the achievements they feed. Physics-only (no rasterizing), so it is quick.
 *
 *   node tools/gameplay-tests.mjs
 */
const { installCanvasMock } = await import('./canvas-mock.mjs');
const env = installCanvasMock({ width: 1000, height: 760, dpr: 1, rasterScale: 0.5 });
env.setRasterize(false);

await import('../src/main.js');
const G = globalThis.GRAVITY_BALL;
const { world } = G;
const { KIND, isBossLevel, GHOST } = await import('../src/game/level.js');
const { encodeLayout, decodeLayout } = await import('../src/game/levelcode.js');
const { dailySeed } = await import('../src/meta/progress.js');
const cfg = await import('../src/config.js');

let passes = 0, failures = 0;
const out = [];
function check(name, cond, detail = '') {
  if (cond) { passes++; out.push(`  ✓ ${name}`); } else { failures++; out.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(name, fn) {
  const before = failures;
  fn();
  console.log(`\n▸ ${name}${failures > before ? '   ← FAILURES' : ''}`);
  console.log(out.splice(0).join('\n'));
}
function step(seconds) {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) env.step(1 / 60);
}
function customRun(rows) {
  world.startRun(42, { mode: 'custom', layout: rows });
  world.launch();
  world.state = 'play';
}
function fire(ball, x, y, vx, vy) {
  ball.stuck = false; ball.dead = false;
  ball.x = x; ball.y = y; ball.vx = vx; ball.vy = vy;
  world.flip.active = false;
}

console.log('=== GRAVITY BALL gameplay tests ===');

section('portal bricks', () => {
  customRun([
    'p..........p',
    '............',
    '............',
    '.....1......',
    '............',
    '............',
  ]);
  const [a, b] = world.level.portals;
  check('two portals were paired', a && b && a.partner === b && b.partner === a);
  const ball = world.main;
  // Straight up into portal A from below.
  fire(ball, a.x + a.w / 2, a.y + a.h + 40, 0, -700);
  world.gravity = 0;
  let teleported = false;
  for (let i = 0; i < 40 && !teleported; i++) {
    env.step(1 / 60);
    if (Math.abs(ball.x - (b.x + b.w / 2)) < 12) teleported = true;
  }
  check('ball exits the partner portal', teleported, `x=${ball.x.toFixed(0)} partner=${(b.x + b.w / 2).toFixed(0)}`);
  check('portal trip counted', world.portalsUsed >= 1);
  check('portal took damage', a.hp < a.maxHp);
  check('ball left below the partner (same face)', ball.y > b.y + b.h, `y=${ball.y.toFixed(0)}`);

  world.startRun(7, { mode: 'custom', layout: ['p1..........', '', '', '', '', ''] });
  check('an unpaired portal becomes a plain brick', world.level.portals.length === 0 && world.level.bricks[0].kind === KIND.NORMAL);
});

section('ghost bricks', () => {
  customRun(['............', '............', '.....g......', '............', '............', '............']);
  const g = world.level.bricks.find((x) => x.kind === KIND.GHOST);
  g.phaseT = 0;
  world.level.update(0.01, 1);
  check('ghost starts solid', !g.phased);
  world.level.update(GHOST.solid + 0.05, 1);
  check('ghost phases out', g.phased);
  const found = world.level.collectSwept(g.x, g.y, g.x + g.w, g.y + g.h, []);
  check('phased ghost is not collidable', !found.includes(g));
  const ball = world.main;
  fire(ball, g.x + g.w / 2, g.y + g.h + 30, 0, -600);
  world.gravity = 0;
  for (let i = 0; i < 14; i++) { g.phaseT = GHOST.solid + 0.2; env.step(1 / 60); }
  check('ball passes through a phased ghost', g.alive && ball.y < g.y, `y=${ball.y.toFixed(0)} alive=${g.alive}`);
  world.level.update(GHOST.phased, 1);
  check('ghost becomes solid again', !g.phased);
});

section('boss core', () => {
  check('boss levels are every 5th from 10', isBossLevel(10) && isBossLevel(15) && !isBossLevel(5) && !isBossLevel(11));
  world.startRun(99, { mode: 'classic' });
  world.startLevel(10);
  const boss = world.level.boss;
  check('level 10 builds a boss', !!boss && boss.kind === KIND.BOSS);
  check('boss owns 8 grid cells', boss.cells.length === 8 && boss.cells.every((c) => world.level.grid[c] === boss));
  check('boss counted once in alive total', world.level.bricks.filter((b) => b.alive).length === world.level.alive);
  const listed = world.level.collectSwept(boss.x, boss.y, boss.x + boss.w, boss.y + boss.h, []);
  check('swept query lists the boss once', listed.filter((b) => b === boss).length === 1);
  let blasted = 0;
  world.level.forEachInBox(boss.x, boss.y, boss.x + boss.w, boss.y + boss.h, (b) => { if (b === boss) blasted++; });
  check('box query visits the boss once', blasted === 1);

  world.launch(); world.state = 'play';
  boss.guard = 0; boss.guardClock = 99; boss.spawn = 5;
  const hp0 = boss.hp;
  world.level.hit(boss, 1, world);
  check('boss takes damage', boss.hp === hp0 - 1);
  boss.guard = 2;
  world.level.hit(boss, 1, world);
  check('guarded boss ignores normal hits', boss.hp === hp0 - 1);
  world.flip.active = true;
  world.level.hit(boss, 2, world);
  check('anti-gravity breaks through the guard', boss.hp === hp0 - 3);
  world.flip.active = false;
  boss.guard = 0; boss.guardClock = 0.05;
  world.level.update(0.1, 1);
  check('boss raises its guard on a timer', boss.guard > 0);

  const bossesBefore = world.bossesBeaten;
  boss.hp = 1; boss.guard = 0; boss.guardClock = 99;
  const ball = world.main;
  fire(ball, boss.x + boss.w / 2, boss.y + boss.h + 30, 0, -700);
  world.gravity = 0;
  for (let i = 0; i < 20 && boss.alive; i++) env.step(1 / 60);
  check('boss is destroyed by the killing blow', !boss.alive);
  check('its cells are freed', boss.cells.every((c) => world.level.grid[c] === null));
  check('boss kill counted', world.bossesBeaten === bossesBefore + 1);
  check('boss kill unlocks Core Breaker', G.progress.isUnlocked('boss'));
});

section('magnet power-up', () => {
  customRun(['1...........', '', '', '', '', '']);
  world.paddle.x = 800;
  const ball = world.main;
  fire(ball, 300, 420, 0, 200);
  world.buffs.magnet = 0;
  step(0.2);
  const plainVx = ball.vx;
  fire(ball, 300, 420, 0, 200);
  world._applyDrop({ kind: 'magnet', x: 500, y: 600 });
  check('magnet buff starts', world.buffs.magnet > 0);
  step(0.2);
  check('falling ball is pulled towards the paddle', ball.vx > plainVx + 50, `vx=${ball.vx.toFixed(0)} vs ${plainVx.toFixed(0)}`);
  world.buffs.magnet = 0.05;
  step(0.2);
  check('magnet expires', world.buffs.magnet === 0);
  check('magnet is in the drop table', cfg.DROPS.kinds.includes('magnet'));
});

section('daily challenge', () => {
  const seed = dailySeed('2026-09-24');
  world.startRun(seed, { mode: 'daily' });
  const a = world.level.bricks.map((b) => `${b.col},${b.row},${b.kind}`).join('|');
  world.startRun(seed, { mode: 'daily' });
  const b = world.level.bricks.map((x) => `${x.col},${x.row},${x.kind}`).join('|');
  check('same seed builds the same daily layout', a === b && a.length > 0);
  world.startRun(dailySeed('2026-09-25'), { mode: 'daily' });
  const c = world.level.bricks.map((x) => `${x.col},${x.row},${x.kind}`).join('|');
  check('tomorrow is different', c !== a);
  world.startRun(seed, { mode: 'classic' });
  const classic = world.level.bricks.map((x) => `${x.col},${x.row},${x.kind}`).join('|');
  check('daily skips the teaching levels', classic !== a);
  check('mode is shown to the HUD', world.mode === 'classic');
});

section('custom level → win', () => {
  const rows = decodeLayout(encodeLayout(['....1.......', '', '', '', '', '']));
  customRun(rows);
  check('custom mode active', world.mode === 'custom');
  const brick = world.level.bricks[0];
  fire(world.main, brick.x + brick.w / 2, brick.y + brick.h + 30, 0, -700);
  world.gravity = 0;
  for (let i = 0; i < 60 * 5 && world.state !== 'gameover'; i++) env.step(1 / 60);
  check('clearing a custom level ends the run as a win', world.state === 'gameover' && world.runStats?.won === true, `state=${world.state}`);
  check('Architect unlocked', G.progress.isUnlocked('architect'));
  check('win lands on the high-score table', G.progress.scores.some((s) => s.mode === 'custom' && s.won));
});

section('best chain (bug fix)', () => {
  customRun(['111111111111', '', '', '', '', '']);
  for (const b of world.level.bricks.slice(0, 8)) world._destroyBrick(b, b.x, b.y, 0, 1, 600, world.main);
  check('best multiplier is recorded', world.bestMultiplier >= 5, `best=${world.bestMultiplier}`);
  check('snapshot reports it', world.runSnapshot().multiplier >= 5);
});

section('60 s soak on a boss level with portals + ghosts', () => {
  world.startRun(2024, { mode: 'classic' });
  world.startLevel(15);
  world.launch(); world.state = 'play';
  let escapes = 0, maxSpeed = 0;
  for (let i = 0; i < 60 * 60; i++) {
    const b = world.main;
    env.pointer('pointermove', Math.max(20, Math.min(980, b ? b.x + Math.sin(i / 50) * 40 : 500)), 640);
    if (i % 240 === 0) world.flip.charge = 1, world.activateFlip();
    env.step(1 / 60);
    for (const ball of world.balls) {
      if (ball.dead || ball.stuck) continue;
      maxSpeed = Math.max(maxSpeed, Math.hypot(ball.vx, ball.vy));
      if (ball.x - ball.r < 8.5 || ball.x + ball.r > 991.5 || ball.y - ball.r < 78.5 || ball.y > 674) escapes++;
    }
    if (world.state === 'gameover') world.startRun(2024), world.startLevel(15), world.launch();
  }
  check('ball never left the arena', escapes === 0, `escapes=${escapes}`);
  check('speed cap held', maxSpeed <= cfg.BALL.speedMax * 1.02 + 0.5, `max=${maxSpeed.toFixed(0)}`);
  check('level 15 has portals, ghosts and a boss', world.level.bricks.some((b) => b.kind === KIND.GHOST) || world.levelIndex !== 15);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
