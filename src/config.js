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
