/**
 * meta-tests.mjs — fast unit tests for the pure modules that don't need the
 * canvas: level share codes and the progression system.
 *
 *   node tools/meta-tests.mjs
 */
import { encodeLayout, decodeLayout, validateLayout, normalizeLayout, layoutFromHash } from '../src/game/levelcode.js';
import { Progress, ACHIEVEMENTS, SKINS, SCORE_TABLE_SIZE, dailySeed, dayKey } from '../src/meta/progress.js';

let passes = 0, failures = 0;
function check(name, cond, detail = '') {
  if (cond) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    read: (k, f) => (m.has(k) ? JSON.parse(m.get(k)) : f),
    write: (k, v) => m.set(k, JSON.stringify(v)),
    raw: m,
  };
}

console.log('=== GRAVITY BALL meta tests ===');

console.log('\n▸ level share codes');
const layout = [
  'p..1111...p.',
  '.a2bs22gg2a.',
  '....B.......',
  '333333333333',
  '.4.4.4.4.4.4',
  '............',
];
const code = encodeLayout(layout);
check('code is URL-safe', /^g1\.[A-Za-z0-9_-]+$/.test(code), code);
check('code is compact (<= 60 chars)', code.length <= 60, String(code.length));
check('round-trips exactly', JSON.stringify(decodeLayout(code)) === JSON.stringify(layout));
check('rejects garbage', decodeLayout('hello') === null);
check('rejects wrong version', decodeLayout(code.replace('g1.', 'g2.')) === null);
const tampered = code.slice(0, 10) + (code[10] === 'A' ? 'B' : 'A') + code.slice(11);
check('rejects a tampered code (checksum)', decodeLayout(tampered) === null);
check('rejects truncated codes', decodeLayout(code.slice(0, -4)) === null);
check('normalises short/odd input', normalizeLayout(['1Z', '']).every((r) => r.length === 12) && normalizeLayout(['1Z'])[0].startsWith('1.'));
check('empty layout is invalid', validateLayout([]).length > 0);
check('two bosses are invalid', validateLayout(['B...B.......']).some((p) => /boss/i.test(p)));
check('odd portal count warns', validateLayout(['p1..........']).some((p) => /pairs/i.test(p)));
check('good layout validates', validateLayout(layout).length === 0, validateLayout(layout).join('; '));
check('reads #level= from a hash', JSON.stringify(layoutFromHash(`#level=${code}`)) === JSON.stringify(layout));
check('ignores unrelated hashes', layoutFromHash('#daily') === null);

console.log('\n▸ progression');
const store = memStore();
const p = new Progress(store);
check('starts empty', p.scores.length === 0 && p.unlockedCount === 0);
check('default skin is Neon', p.skin.id === 'neon');
check('locked skin cannot be equipped', p.setSkin('void').id === 'neon');

const run = (o) => ({ score: 1000, level: 1, bricks: 10, multiplier: 1, time: 60, flips: 2, mode: 'classic', portals: 0, bosses: 0, maxBalls: 1, ...o });
let res = p.onEvent('gameOver', run({ score: 5000 }));
check('first run ranks #1', res.rank === 0);
check('first brick achievement unlocks at game over', res.unlocked.some((a) => a.id === 'first-blood'));
res = p.onEvent('gameOver', run({ score: 3000 }));
check('lower score ranks #2', res.rank === 1);
check('table is sorted', p.scores[0].score === 5000 && p.scores[1].score === 3000);

for (let i = 0; i < 15; i++) p.onEvent('gameOver', run({ score: 100 + i }));
check(`table capped at ${SCORE_TABLE_SIZE}`, p.scores.length === SCORE_TABLE_SIZE);
check('a score below the table does not rank', p.rankOf(50) === -1);
check('lifetime runs counted', p.stats.runs === 17);
check('Regular unlocked after 10 runs', p.isUnlocked('regular'));

res = p.onEvent('multiplier', 8, run({ multiplier: 8 }));
check('x8 unlocks mid-run', res.unlocked.some((a) => a.id === 'chain-8'));
check('Ember skin now equippable', p.setSkin('ember').id === 'ember');
check('skinsFor maps achievements to skins', Progress.skinsFor(['chain-8'])[0]?.id === 'ember');
check('cycleSkin only visits unlocked skins', (() => {
  const seen = new Set();
  for (let i = 0; i < 6; i++) seen.add(p.cycleSkin(1).id);
  return [...seen].every((id) => p.skinUnlocked(SKINS.find((s) => s.id === id)));
})());

res = p.onEvent('levelClear', { level: 3, flawless: true }, run({ level: 3 }));
check('flawless clear unlocks', res.unlocked.some((a) => a.id === 'flawless'));
res = p.onEvent('levelClear', { level: 4, flawless: true }, run({ level: 4 }));
check('achievements unlock only once', !res.unlocked.some((a) => a.id === 'flawless'));

res = p.onEvent('gameOver', run({ mode: 'daily', score: 900, dayKey: '2026-09-24' }));
check('daily run unlocks Daily Grind', res.unlocked.some((a) => a.id === 'daily'));
check('daily best recorded', p.dailyBest('2026-09-24') === 900 && res.dailyBest);
res = p.onEvent('gameOver', run({ mode: 'daily', score: 400, dayKey: '2026-09-24' }));
check('worse daily does not overwrite', p.dailyBest('2026-09-24') === 900 && !res.dailyBest);
res = p.onEvent('gameOver', run({ mode: 'custom', won: true }));
check('beating a custom level unlocks Architect', res.unlocked.some((a) => a.id === 'architect'));

const p2 = new Progress(store);
check('state persists across reloads', p2.scores.length === SCORE_TABLE_SIZE && p2.isUnlocked('chain-8') && p2.skin.id === p.skin.id);

const corrupt = new Progress(memStore({ 'gb.progress.v1': JSON.stringify({ scores: 'nope', stats: { runs: 'x', bricks: 5 }, unlocked: { fake: 1, boss: 'd' }, daily: { bad: 1 } }) }));
check('corrupt save loads safely', corrupt.scores.length === 0 && corrupt.stats.runs === 0 && corrupt.stats.bricks === 5);
check('unknown achievement ids dropped, known kept', corrupt.isUnlocked('boss') && corrupt.unlockedCount === 1);
check('every skin unlock names a real achievement', SKINS.every((s) => !s.unlock || ACHIEVEMENTS.some((a) => a.id === s.unlock)));
check('achievement ids are unique', new Set(ACHIEVEMENTS.map((a) => a.id)).size === ACHIEVEMENTS.length);

console.log('\n▸ daily seed');
check('same day, same seed', dailySeed('2026-09-24') === dailySeed('2026-09-24'));
check('different day, different seed', dailySeed('2026-09-24') !== dailySeed('2026-09-25'));
check('dayKey is YYYY-MM-DD', /^\d{4}-\d\d-\d\d$/.test(dayKey()));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
