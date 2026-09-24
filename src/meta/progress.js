/**
 * progress.js — everything that outlives a single run: the local high-score
 * table, achievements, lifetime stats, paddle skins and daily-challenge bests.
 *
 * Pure logic with an injected key/value store, so it runs unchanged in the
 * browser (localStorage) and in the Node test suite (a Map). Nothing here
 * touches the canvas; main.js turns the returned events into banners.
 */

export const SCORE_TABLE_SIZE = 10;
const KEY = 'gb.progress.v1';

/** Every achievement. `test(ctx)` sees { run, stats, event, data }. */
export const ACHIEVEMENTS = [
  { id: 'first-blood', name: 'First Blood', desc: 'Break your first brick', test: ({ stats }) => stats.bricks >= 1 },
  { id: 'chain-8', name: 'Hot Streak', desc: 'Reach a x8 multiplier', test: ({ run }) => run.multiplier >= 8 },
  { id: 'chain-16', name: 'Maxed Out', desc: 'Reach the x16 multiplier cap', test: ({ run }) => run.multiplier >= 16 },
  { id: 'level-5', name: 'Graduate', desc: 'Reach level 5', test: ({ run }) => run.level >= 5 },
  { id: 'level-10', name: 'Deep Run', desc: 'Reach level 10', test: ({ run }) => run.level >= 10 },
  { id: 'score-50k', name: 'Fifty Grand', desc: 'Score 50,000 in one run', test: ({ run }) => run.score >= 50000 },
  { id: 'score-150k', name: 'High Roller', desc: 'Score 150,000 in one run', test: ({ run }) => run.score >= 150000 },
  { id: 'flipper', name: 'Flipper', desc: 'Use 25 gravity flips in one run', test: ({ run }) => run.flips >= 25 },
  { id: 'flawless', name: 'Flawless', desc: 'Clear a level without losing a ball', test: ({ event, data }) => event === 'levelClear' && data?.flawless },
  { id: 'crowd', name: 'Crowd Control', desc: 'Have 5 balls in play at once', test: ({ run }) => run.maxBalls >= 5 },
  { id: 'wormhole', name: 'Wormhole', desc: 'Travel through 10 portals in one run', test: ({ run }) => run.portals >= 10 },
  { id: 'boss', name: 'Core Breaker', desc: 'Destroy a boss core', test: ({ run }) => run.bosses >= 1 },
  { id: 'daily', name: 'Daily Grind', desc: 'Finish a daily challenge', test: ({ event, run }) => event === 'gameOver' && run.mode === 'daily' },
  { id: 'architect', name: 'Architect', desc: 'Beat a custom level', test: ({ event, run }) => event === 'gameOver' && run.mode === 'custom' && run.won },
  { id: 'regular', name: 'Regular', desc: 'Play 10 runs', test: ({ stats }) => stats.runs >= 10 },
  { id: 'marathon', name: 'Marathon', desc: 'Break 2,500 bricks in total', test: ({ stats }) => stats.bricks >= 2500 },
];

/**
 * Paddle skins. `unlock` names the achievement that earns it (null = always).
 * Colours are consumed by paddle.js: core glow, deep body, trail tint.
 */
export const SKINS = [
  { id: 'neon', name: 'Neon', unlock: null, core: '#7df9ff', deep: '#0a2f45', trail: '#a06bff' },
  { id: 'ember', name: 'Ember', unlock: 'chain-8', core: '#ff9a3d', deep: '#3a1606', trail: '#ff3b5c' },
  { id: 'toxic', name: 'Toxic', unlock: 'level-5', core: '#b6ff45', deep: '#1c3306', trail: '#3dffb0' },
  { id: 'royal', name: 'Royal', unlock: 'score-50k', core: '#ffc843', deep: '#3a2a04', trail: '#ff5ec4' },
  { id: 'phantom', name: 'Phantom', unlock: 'flawless', core: '#e6e9ff', deep: '#1a1d33', trail: '#c9d6ff' },
  { id: 'void', name: 'Void', unlock: 'boss', core: '#ff3fa4', deep: '#2a0418', trail: '#7c5cff' },
  { id: 'prism', name: 'Prism', unlock: 'chain-16', core: '#ffffff', deep: '#222a3a', trail: 'rainbow' },
];

function emptyState() {
  return {
    scores: [],                // [{ score, level, mode, preset, date, won }]
    unlocked: {},              // id -> ISO date
    stats: { runs: 0, bricks: 0, flips: 0, time: 0, bestChain: 1, bosses: 0, portals: 0, levels: 0 },
    skin: 'neon',
    daily: {},                 // 'YYYY-MM-DD' -> best score
  };
}

/** Today's date key in local time — the daily challenge rolls over at midnight. */
export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Stable 32-bit seed for a day key, so every player gets the same layouts. */
export function dailySeed(key = dayKey()) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Progress {
  /** `store` is { read(key, fallback), write(key, value) }. */
  constructor(store) {
    this.store = store;
    const saved = store.read(KEY, null);
    this.state = mergeState(emptyState(), saved);
  }

  save() { this.store.write(KEY, this.state); }

  // ---------------------------------------------------------------- queries --
  get scores() { return this.state.scores; }
  get stats() { return this.state.stats; }
  isUnlocked(id) { return !!this.state.unlocked[id]; }
  get unlockedCount() { return Object.keys(this.state.unlocked).length; }

  skinUnlocked(skin) { return !skin.unlock || this.isUnlocked(skin.unlock); }
  get skin() {
    const s = SKINS.find((k) => k.id === this.state.skin);
    return s && this.skinUnlocked(s) ? s : SKINS[0];
  }

  /** Select a skin; refuses locked or unknown ones. Returns the active skin. */
  setSkin(id) {
    const s = SKINS.find((k) => k.id === id);
    if (s && this.skinUnlocked(s)) { this.state.skin = id; this.save(); }
    return this.skin;
  }

  /** Cycle through unlocked skins only. */
  cycleSkin(dir = 1) {
    const open = SKINS.filter((s) => this.skinUnlocked(s));
    const i = open.findIndex((s) => s.id === this.skin.id);
    return this.setSkin(open[(i + dir + open.length) % open.length].id);
  }

  dailyBest(key = dayKey()) { return this.state.daily[key] ?? 0; }

  /** Where `score` would land in the table (0-based), or -1 if it would not. */
  rankOf(score) {
    if (score <= 0) return -1;
    const i = this.state.scores.findIndex((s) => score > s.score);
    if (i >= 0) return i;
    return this.state.scores.length < SCORE_TABLE_SIZE ? this.state.scores.length : -1;
  }

  // ---------------------------------------------------------------- events --

  /**
   * Feed a world event in. Returns the achievements this event unlocked
   * (possibly empty) so the caller can celebrate them.
   * `run` is a live snapshot of the current run: see World.runSnapshot().
   */
  onEvent(event, data, run) {
    const st = this.state.stats;
    let result = { unlocked: [] };
    if (event === 'levelClear') st.levels++;
    if (event === 'gameOver') result = { ...this._finishRun(data), unlocked: [] };
    const ctxRun = event === 'gameOver' ? data : run;
    if (ctxRun) result.unlocked = this._checkAchievements({ run: ctxRun, stats: st, event, data });
    this.save();
    return result;
  }

  _finishRun(run) {
    const st = this.state.stats;
    st.runs++;
    st.bricks += run.bricks ?? 0;
    st.flips += run.flips ?? 0;
    st.time += run.time ?? 0;
    st.bestChain = Math.max(st.bestChain, run.multiplier ?? 1);
    st.bosses += run.bosses ?? 0;
    st.portals += run.portals ?? 0;

    const rank = this.rankOf(run.score);
    if (rank >= 0) {
      this.state.scores.splice(rank, 0, {
        score: run.score, level: run.level, mode: run.mode ?? 'classic',
        preset: run.preset ?? 'arcade', date: run.date ?? new Date().toISOString(), won: !!run.won,
      });
      this.state.scores.length = Math.min(this.state.scores.length, SCORE_TABLE_SIZE);
    }
    let dailyBest = false;
    if (run.mode === 'daily') {
      const k = run.dayKey ?? dayKey();
      if (run.score > (this.state.daily[k] ?? 0)) { this.state.daily[k] = run.score; dailyBest = true; }
      // keep only the last 30 days
      const keys = Object.keys(this.state.daily).sort();
      while (keys.length > 30) delete this.state.daily[keys.shift()];
    }
    return { rank, dailyBest };
  }

  _checkAchievements(ctx) {
    const out = [];
    for (const a of ACHIEVEMENTS) {
      if (this.state.unlocked[a.id]) continue;
      let ok = false;
      try { ok = !!a.test(ctx); } catch { ok = false; }
      if (ok) {
        this.state.unlocked[a.id] = new Date().toISOString();
        out.push(a);
      }
    }
    return out;
  }

  /** Skins that `achievementIds` just unlocked (for the celebration banner). */
  static skinsFor(achievementIds) {
    return SKINS.filter((s) => s.unlock && achievementIds.includes(s.unlock));
  }

  reset() { this.state = emptyState(); this.save(); }
}

/** Tolerant merge: a corrupted or older save can never crash the game. */
function mergeState(base, saved) {
  if (!saved || typeof saved !== 'object') return base;
  if (Array.isArray(saved.scores)) {
    base.scores = saved.scores
      .filter((s) => s && Number.isFinite(s.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, SCORE_TABLE_SIZE);
  }
  if (saved.unlocked && typeof saved.unlocked === 'object') {
    for (const a of ACHIEVEMENTS) if (saved.unlocked[a.id]) base.unlocked[a.id] = saved.unlocked[a.id];
  }
  if (saved.stats && typeof saved.stats === 'object') {
    for (const k of Object.keys(base.stats)) if (Number.isFinite(saved.stats[k])) base.stats[k] = saved.stats[k];
  }
  if (typeof saved.skin === 'string') base.skin = saved.skin;
  if (saved.daily && typeof saved.daily === 'object') {
    for (const [k, v] of Object.entries(saved.daily)) if (/^\d{4}-\d\d-\d\d$/.test(k) && Number.isFinite(v)) base.daily[k] = v;
  }
  return base;
}
