/**
 * math.js — small, allocation-free helpers.
 *
 * Everything the game needs from trigonometry, easing, RNG and collision
 * detection lives here so the game modules stay about *game feel*.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/**
 * Frame-rate independent smoothing: moves `a` toward `b` with a half-life
 * expressed by `lambda` (higher = snappier). Used for the paddle, camera
 * and basically every value that should feel "connected" to input.
 */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

// ---------------------------------------------------------------- easing ---
export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export const easeOutQuint = (t) => 1 - (1 - t) ** 5;
export const easeInCubic = (t) => t * t * t;
export const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
export const easeOutElastic = (t) => {
  if (t === 0 || t === 1) return t;
  const p = 0.35;
  return 2 ** (-10 * t) * Math.sin(((t - p / 4) * TAU) / p) + 1;
};
export const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
export const smoothstep = (t) => t * t * (3 - 2 * t);

// ------------------------------------------------------------------ noise ---
/**
 * Cheap deterministic value noise in [0,1). Used for camera shake and grain
 * so we never allocate or pull in a noise library.
 */
export function hashNoise(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

// -------------------------------------------------------------------- rng ---
/** mulberry32: tiny seeded PRNG — levels are reproducible from one integer. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (rng, arr) => arr[(rng() * arr.length) | 0];

// ------------------------------------------------------------------- color ---
/**
 * Parse a colour into {r,g,b}. Accepts '#rgb', '#rrggbb' *and* the 'rgb()' /
 * 'rgba()' strings that mixHex() itself returns — the colour helpers are
 * deliberately composable (mixHex(a, b) -> mixHex(that, c)), and an invalid
 * CSS colour would otherwise be silently ignored by the canvas, which is a
 * genuinely nasty class of bug to track down. Cached: palettes are hot.
 */
const rgbCache = new Map();
export function hexToRgb(color) {
  let c = rgbCache.get(color);
  if (c) return c;
  if (typeof color !== 'string') {
    c = { r: 255, g: 0, b: 255 };                  // loud magenta: never silent
  } else if (color[0] === '#') {
    const hex = color.slice(1);
    const n = parseInt(hex.length === 3
      ? hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
      : hex, 16);
    c = Number.isFinite(n)
      ? { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
      : { r: 255, g: 0, b: 255 };
  } else if (color.startsWith('rgb')) {
    const nums = color.replace(/[^0-9.]+/g, ' ').trim().split(/\s+/).map(Number);
    c = Number.isFinite(nums[0]) && Number.isFinite(nums[2])
      ? { r: nums[0] | 0, g: nums[1] | 0, b: nums[2] | 0 }
      : { r: 255, g: 0, b: 255 };
  } else {
    c = { r: 255, g: 0, b: 255 };
  }
  rgbCache.set(color, c);
  return c;
}

/** Mix two colours (hex or rgb() strings), returns a css rgb() string. */
export function mixHex(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const x = hexToRgb(a), y = hexToRgb(b);
  return `rgb(${(x.r + (y.r - x.r) * t) | 0},${(x.g + (y.g - x.g) * t) | 0},${(x.b + (y.b - x.b) * t) | 0})`;
}

/** Shift a colour's brightness. `k` < 1 darkens, > 1 brightens. */
export function shade(hex, k) {
  const c = hexToRgb(hex);
  const f = (v) => clamp(Math.round(v * k), 0, 255);
  return `rgb(${f(c.r)},${f(c.g)},${f(c.b)})`;
}

/** `rgba()` string from any supported colour + alpha. */
export function rgba(color, a) {
  const c = hexToRgb(color);
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}

// --------------------------------------------------------------- collision ---

/**
 * Swept circle vs axis-aligned box (continuous collision detection).
 *
 * This is the Minkowski trick: growing the box by the circle radius turns the
 * swept-circle problem into a plain ray-vs-box slab test, which is exact and
 * cheap — no tunnelling, no sub-stepping, and it gives us the *time of impact*
 * so the ball can be advanced precisely to the contact point.
 *
 * @returns {{t:number, nx:number, ny:number}|null} t in [0,1] along (vx,vy).
 */
export function sweepCircleBox(cx, cy, vx, vy, r, box) {
  const minX = box.x - r, maxX = box.x + box.w + r;
  const minY = box.y - r, maxY = box.y + box.h + r;

  // Bail out early when the swept bounding box cannot reach the slab.
  if (cx < minX && cx + vx < minX) return null;
  if (cx > maxX && cx + vx > maxX) return null;
  if (cy < minY && cy + vy < minY) return null;
  if (cy > maxY && cy + vy > maxY) return null;

  const invX = vx !== 0 ? 1 / vx : Infinity;
  const invY = vy !== 0 ? 1 / vy : Infinity;

  let tNearX = (minX - cx) * invX;
  let tFarX = (maxX - cx) * invX;
  if (tNearX > tFarX) { const s = tNearX; tNearX = tFarX; tFarX = s; }

  let tNearY = (minY - cy) * invY;
  let tFarY = (maxY - cy) * invY;
  if (tNearY > tFarY) { const s = tNearY; tNearY = tFarY; tFarY = s; }

  const tNear = Math.max(tNearX, tNearY);
  const tFar = Math.min(tFarX, tFarY);
  if (tNear > tFar || tFar < 0) return null;

  // Axis of the earliest contact decides the collision normal.
  if (tNearX > tNearY) {
    const nx = vx > 0 ? -1 : 1;
    // Already overlapping at t=0: push straight out.
    if (tNear < 0) return { t: 0, nx, ny: 0 };
    return tNear <= 1 ? { t: tNear, nx, ny: 0 } : null;
  }
  const ny = vy > 0 ? -1 : 1;
  if (tNear < 0) return { t: 0, nx: 0, ny };
  return tNear <= 1 ? { t: tNear, nx: 0, ny } : null;
}

/** Circle vs point distance squared — used for explosion falloff. */
export const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
