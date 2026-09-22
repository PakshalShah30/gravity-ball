/**
 * config.js — every tunable number in one place.
 *
 * Game feel is a search problem: this file is the search space. Nothing here
 * has a "correct" value, but the comments explain what each knob does to the
 * feel so you can dial the game from floaty to frantic in one file.
 */

// The game is authored in a fixed virtual resolution and letterboxed to the
// window, so physics numbers are resolution independent.
export const VIEW = { w: 1000, h: 760 };
export const HUD_H = 70;    // score / level / lives band
export const FOOT_H = 80;   // gravity meter band (also the touch button area)

// Playfield: the rectangular arena the ball lives in. No bottom wall — the
// floor is a shredder that costs a life.
export const FIELD = {
  x: 10, y: 80, w: 980, h: 590,
  wall: 10,           // frame thickness (visual only, physics uses the interior)
  bottom: 670,        // interior bottom edge == death line
};
export const FRAME = { x: 0, y: HUD_H, w: VIEW.w, h: FIELD.bottom + FIELD.wall - HUD_H };

// ------------------------------------------------------------------ bricks --
export const GRID = {
  cols: 12, rows: 6,
  bw: 73, bh: 26,      // brick cell size
  gapX: 6, gapY: 8,
  originX: 29, originY: 108,
};
// pitch = cell + gap
GRID.pitchX = GRID.bw + GRID.gapX;
GRID.pitchY = GRID.bh + GRID.gapY;

// -------------------------------------------------------------------- ball --
export const BALL = {
  r: 11,
  speed: 600,          // launch speed
  speedPerLevel: 22,   // progressive difficulty
  speedMax: 1420,      // hard cap keeps CCD honest and play readable
  speedMin: 380,       // enforced after every bounce: the ball never stalls
  bumpPerHit: 1.012,   // slight acceleration per brick (classic breakout spike)
  gravity: 420,        // px/s² — this is *the* game: the ball arcs
  gravityPerLevel: 9,
  gravityFlip: -1560,  // upwards yank during a gravity flip
  trail: 24,           // trail samples
  squash: 0.34,        // squash & stretch amount at high speed
};

// ------------------------------------------------------------------ paddle --
export const PADDLE = {
  y: 620, h: 16,
  w: 130, wWide: 186,
  follow: 30,          // exponential follow rate (higher = tighter to pointer)
  inertia: 0.16,       // how much paddle motion is transferred to the ball
  maxAngle: 62,        // degrees off vertical at the paddle's edge
  squash: 0.42,        // vertical squash on impact
};

// --------------------------------------------------------- gravity flip ---
export const FLIP = {
  duration: 1.05,      // seconds of anti-gravity
  cooldown: 1.15,      // recharge after it ends (full cycle ~2.2 s)
  damage: 2,           // bricks take double damage while flipped
  speedBoost: 1.06,
  hitstop: 0.05,       // freeze frames on activation
  slowmoScale: 0.62,   // dramatic dip on activation...
  slowmoTime: 0.42,    // ...easing back to real time over this long
};

// ------------------------------------------------------------------ combo --
export const COMBO = {
  perMultiplier: 2,    // bricks per +1 multiplier
  max: 16,
  timeout: 3.5,        // seconds of no breaks before the chain drops
  popupPitch: 1,       // (see audio.js) rising pitch ladder per chain step
};

export const SCORING = {
  brick: { basic: 100, armored: 250, bomb: 300, shield: 400 },
  airChain: 150,       // per brick in one airborne phase
  levelClear: 1000,
  lifeBonus: 250,
  flipBonus: 500,      // clearing a level with the gravity flip ready
  extraLife: 20000,    // points per extra ball
};

export const LIVES_START = 3;

export const DROPS = {
  chance: 0.11,        // per destroyed brick (bombs always drop)
  speed: 190,
  kinds: ['wide', 'multi', 'slow', 'grav', 'points'],
  duration: { wide: 14, slow: 7, grav: 12 },
};

export const TIMING = {
  readyDelay: 0.35,    // pause after a life is lost / level starts
  clearDelay: 2.4,     // level-clear celebration length
  introTime: 0.5,      // bricks assemble
  fixedDt: 1 / 120,    // simulation step
  maxFrame: 0.25,      // spiral-of-death guard
};

// ------------------------------------------------------------------ juice --
export const JUICE = {
  shakeBrick: 0.10,
  shakeArmored: 0.16,
  shakeBomb: 0.55,
  shakePaddle: 0.13,
  shakeWall: 0.05,
  shakeFlip: 0.60,
  shakeLife: 1.0,
  shakeClear: 0.45,
  shakeDecay: 1.7,     // trauma units per second
  shakeMax: 30,        // px at trauma = 1
  shakeRotMax: 0.022,  // radians at trauma = 1
  hitstopBrick: 0.022,
  hitstopBomb: 0.11,
  hitstopPaddle: 0.03,
  hitstopLevel: 0.28,
  bloom: 0.95,         // additive glow strength
  bloomWide: 0.42,     // second, wider halo
  vignette: 0.55,
  scanlines: 0.05,
  aberration: 0.55,    // peak chromatic aberration on huge impacts
  flashBomb: 0.42,
};

export const COLORS = {
  bg0: '#04050a',
  bg1: '#0d1226',
  grid: '#1b2740',
  frame: '#18233a',
  frameHot: '#3ce7ff',
  pit: '#ff3b5c',
  ball: '#eaf6ff',
  ballHue: '#38f5ff',
  paddle: '#7df9ff',
  paddleDeep: '#0a2f45',
  text: '#e8f4ff',
  dim: '#7d8ba6',
  accent: '#38f5ff',
  gold: '#ffc843',
  danger: '#ff3b5c',
  flip: '#a06bff',
  // Row palette — also drives the particle colors, so bricks shatter into
  // their own color. Saturation stays high for the additive glow pass.
  brick: ['#3ce7ff', '#5aa8ff', '#8b7cff', '#ff5ec4', '#ff7a45', '#ffc843', '#b6ff45', '#3dffb0'],
  armored: '#9fb3c8',
  bomb: '#ff5040',
  bombCore: '#ffd166',
  shield: '#7c5cff',
};

// ---------------------------------------------------------------- presets ---
/**
 * Feel presets.
 *
 * A preset only ever touches *feel* numbers — never geometry. Brick layout
 * (GRID), the playfield, the virtual resolution and the ball radius stay put,
 * because those are level design, and GRID carries derived values
 * (pitchX/pitchY) computed once at load time. Keeping presets off them means
 * flipping a preset can never desync the layout from the physics.
 *
 * `arcade` is the authored tuning; `floaty` and `frantic` are different reads
 * of the same rules rather than difficulty levels bolted on afterwards, so the
 * game never becomes a different game — it becomes a different *feel*.
 *
 * Each preset is a partial override applied on top of BASELINE, and applying a
 * preset restores BASELINE first. That is what makes switching idempotent:
 * applying `frantic` twice cannot stack, and `floaty -> arcade` fully undoes
 * `floaty` instead of leaving a residue behind.
 */
const BASELINE = {
  BALL: { ...BALL },
  PADDLE: { ...PADDLE },
  FLIP: { ...FLIP },
  COMBO: { ...COMBO },
  DROPS: { ...DROPS },
  JUICE: { ...JUICE },
};

/** The objects a preset is allowed to mutate, by name (used by applyPreset). */
const GROUPS = { BALL, PADDLE, FLIP, COMBO, DROPS, JUICE };

export const PRESETS = {
  floaty: {
    label: 'FLOATY',
    blurb: 'slow arcs · wide paddle · generous flip',
    // Less gravity is the whole identity: the ball hangs, so the player has
    // time to read the arc and set up chains instead of reacting.
    overrides: {
      BALL: { gravity: 300, speed: 520, speedPerLevel: 14, gravityPerLevel: 5, speedMax: 1150, bumpPerHit: 1.008 },
      PADDLE: { w: 168, wWide: 226, follow: 34, maxAngle: 55, inertia: 0.13 },
      FLIP: { duration: 1.35, cooldown: 0.85 },
      COMBO: { timeout: 4.5 },
      DROPS: { chance: 0.14 },
      JUICE: { shakeMax: 20, hitstopBrick: 0.018, hitstopBomb: 0.08, aberration: 0.38, bloom: 0.85 },
    },
  },
  arcade: {
    label: 'ARCADE',
    blurb: 'the authored tuning',
    overrides: {},   // empty on purpose: "arcade" means "exactly as configured above"
  },
  frantic: {
    label: 'FRANTIC',
    blurb: 'heavy ball · narrow paddle · scarce flip',
    // Heavier gravity makes the ball dive early; a narrower paddle and a longer
    // flip cooldown mean every save has to be earned. speedMax deliberately
    // stays at the authored 1420 so continuous collision detection keeps its
    // guarantee (the cap is a physics constraint, not a difficulty knob).
    overrides: {
      BALL: { gravity: 620, speed: 720, speedPerLevel: 32, gravityPerLevel: 14, speedMin: 430, bumpPerHit: 1.02 },
      PADDLE: { w: 108, wWide: 156, follow: 38, maxAngle: 68 },
      FLIP: { duration: 0.85, cooldown: 1.45 },
      COMBO: { timeout: 2.6 },
      DROPS: { chance: 0.09 },
      JUICE: { shakeMax: 38, hitstopBrick: 0.026, hitstopBomb: 0.13, aberration: 0.7, bloom: 1.0 },
    },
  },
};

/** Cycle order for the F3 key: calm -> authored -> chaotic -> calm. */
export const PRESET_ORDER = ['floaty', 'arcade', 'frantic'];

let activePreset = 'arcade';

/** The name of the preset currently applied. */
export function activePresetName() { return activePreset; }

/** True if `name` is a real preset. */
export function isPreset(name) {
  return Object.prototype.hasOwnProperty.call(PRESETS, name);
}

/**
 * Restore every tunable to its authored value, then apply one preset.
 * Returns the preset name, or null if `name` is unknown — in which case the
 * current tuning is left completely untouched rather than half-applied.
 */
export function applyPreset(name) {
  if (!isPreset(name)) return null;
  for (const [group, values] of Object.entries(BASELINE)) Object.assign(GROUPS[group], values);
  for (const [group, values] of Object.entries(PRESETS[name].overrides)) Object.assign(GROUPS[group], values);
  activePreset = name;
  return name;
}

/** Next preset in cycle order (dir of -1 walks backwards). */
export function nextPresetName(dir = 1) {
  const i = PRESET_ORDER.indexOf(activePreset);
  const n = PRESET_ORDER.length;
  return PRESET_ORDER[(((i + dir) % n) + n) % n];
}
