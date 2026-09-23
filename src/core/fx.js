/**
 * fx.js — the juice director.
 *
 * Screen shake, freeze frames, slow-motion, flashes, chromatic aberration,
 * gravity wind and the list of "things that should glow". Game code just calls
 * the intent methods (shake / freeze / flash) and this file decides how the
 * camera and post-processing react.
 *
 * Trauma model: impacts add trauma, trauma decays over time, and the shake
 * amplitude is trauma² — so small hits stay subtle and big ones hit hard.
 */
import { clamp, lerp, damp, hashNoise, TAU } from './math.js';
import { JUICE } from '../config.js';

export class Fx {
  constructor() {
    this.t = 0;
    this.trauma = 0;
    this.kickX = 0;
    this.kickY = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeRot = 0;

    this.hitstop = 0;        // seconds of real time to freeze the sim for
    this.timeScale = 1;      // eased multiplier applied to simulation dt
    this._tsTarget = 1;
    this._slowTimer = 0;
    this.simScale = 1;

    this.flash = 0;
    this.flashColor = '#ffffff';
    this.aberration = 0;
    this.chromaDir = 1;
    this.gravityWind = 0;    // 0..1, drives the anti-gravity particle stream
    this.zoom = 1;
    this.zoomPunch = 0;

    this.shakeEnabled = true;
    /**
     * 0..1 global multiplier for *motion-based* effects (shake, flashes,
     * chromatic fringes). main.js sets it from prefers-reduced-motion so the
     * game stays readable for players who need that; gameplay is unaffected.
     */
    this.motionScale = 1;
    this.glow = [];          // bloom sprites for this frame
    this.glowCount = 0;
    this.maxGlow = 320;
  }

  // ------------------------------------------------------------- authoring ---

  shake(amount, dirX = 0, dirY = 0) {
    amount *= this.motionScale;
    if (!this.shakeEnabled) { this.trauma = Math.min(this.trauma + amount * 0.25, 1); return; }
    this.trauma = clamp(this.trauma + amount, 0, 1.6);
    // Directional camera punch reads as a physical hit from that side.
    this.kickX += dirX * amount * 90;
    this.kickY += dirY * amount * 90;
  }

  freeze(seconds) {
    this.hitstop = Math.max(this.hitstop, seconds);
  }

  slowmo(scale, duration) {
    this._tsTarget = scale;
    this._slowTimer = duration;
  }

  flashScreen(color, amount) {
    amount *= this.motionScale;
    if (amount > this.flash) {
      this.flash = amount;
      this.flashColor = color;
    }
  }

  chroma(amount) {
    this.aberration = Math.max(this.aberration, amount * this.motionScale);
    this.chromaDir = Math.random() < 0.5 ? -1 : 1;
  }

  punch(amount) {
    this.zoomPunch = Math.max(this.zoomPunch, amount);
  }

  /** Queue a bloom sprite for this frame (world coordinates). */
  addGlow(x, y, r, color, alpha = 1) {
    if (this.glowCount >= this.maxGlow) return;
    const g = this.glow[this.glowCount];
    if (g) { g.x = x; g.y = y; g.r = r; g.color = color; g.a = alpha; }
    else this.glow[this.glowCount] = { x, y, r, color, a: alpha };
    this.glowCount++;
  }

  clearGlow() { this.glowCount = 0; }

  // ---------------------------------------------------------------- update ---

  update(realDt) {
    this.t += realDt;

    // Freeze frames stop the simulation dead but keep the camera alive: that
    // tiny pause on impact is what makes hits feel *heavy*.
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      this.simScale = 0;
    } else {
      if (this._slowTimer > 0) {
        this._slowTimer -= realDt;
        if (this._slowTimer <= 0) this._tsTarget = 1;
      }
      this.timeScale = damp(this.timeScale, this._tsTarget, 9, realDt);
      this.simScale = this.timeScale;
    }

    // Shake decays in real time so it still settles while frozen.
    this.trauma = Math.max(0, this.trauma - JUICE.shakeDecay * realDt * (0.5 + this.trauma * 0.9));
    const amt = this.trauma * this.trauma;

    const k = Math.exp(-11 * realDt);
    this.kickX *= k;
    this.kickY *= k;

    // Two-octave sine "noise" — smooth, cheap, and identical on every machine.
    const n = (f, p) => Math.sin(this.t * f + p);
    const sx = (n(37.1, 0.0) * 0.62 + n(23.3, 1.7) * 0.38);
    const sy = (n(41.7, 2.3) * 0.62 + n(29.7, 4.1) * 0.38);
    this.shakeX = sx * JUICE.shakeMax * amt + this.kickX;
    this.shakeY = sy * JUICE.shakeMax * amt * 0.8 + this.kickY;
    this.shakeRot = n(33.4, 0.7) * JUICE.shakeRotMax * amt;

    this.flash *= Math.exp(-7.5 * realDt);
    if (this.flash < 0.002) this.flash = 0;
    this.aberration *= Math.exp(-6.5 * realDt);
    if (this.aberration < 0.004) this.aberration = 0;
    this.zoomPunch *= Math.exp(-9 * realDt);
    this.zoom = 1 + this.zoomPunch;
  }

  /** Push the world transform (called around world drawing, not HUD drawing). */
  applyCamera(ctx, cx, cy) {
    ctx.translate(cx + this.shakeX, cy + this.shakeY);
    if (this.shakeRot !== 0) ctx.rotate(this.shakeRot);
    ctx.translate(-cx, -cy);
  }

  get frozen() { return this.hitstop > 0; }
}

/**
 * Anti-gravity wind: embers streaming upward while the flip is active. Purely
 * cosmetic, but it sells the direction of gravity harder than any text could.
 */
export function emitGravityWind(particles, dt, dir, intensity, field) {
  const n = Math.min(28, 14 * intensity * dt * 60 / 8);
  for (let i = 0; i < n; i++) {
    if (Math.random() > intensity) continue;
    const x = field.x + Math.random() * field.w;
    const y = dir < 0 ? field.y + field.h - Math.random() * 40 : field.y + Math.random() * 40;
    particles.spawn(0, x, y, {
      color: '#a06bff', speed: [0, 0], vx: (Math.random() - 0.5) * 40,
      vy: dir < 0 ? -220 - Math.random() * 320 : 160 + Math.random() * 240,
      life: 0.5 + Math.random() * 0.6, size: 2.2, size1: 0.4,
      glow: 1, alpha: 0.55, drag: 0.2,
    });
  }
}
