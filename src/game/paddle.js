/**
 * paddle.js — the player's hand: an exponential-follow bar with squash &
 * stretch, a heat trail and a reflect normal that is *aimed*, not merely
 * reflected, so the player can steer the ball.
 *
 * Feel notes:
 *  - `follow` is a rate, not a speed: the paddle is always chasing the pointer
 *    and never quite arrives, which reads as weight without input lag.
 *  - The bounce angle comes from where the ball lands (classic breakout), but
 *    the ball's incoming speed is preserved and the paddle's own velocity is
 *    added, so flicking the paddle sideways slingshots the ball.
 */
import { clamp, damp, mixHex, rgba, easeOutCubic, DEG } from '../core/math.js';
import { PADDLE, FIELD, COLORS, JUICE } from '../config.js';

export class Paddle {
  constructor() {
    this.w = PADDLE.w;
    this.targetW = PADDLE.w;
    this.h = PADDLE.h;
    this.x = FIELD.x + FIELD.w / 2;
    this.y = PADDLE.y;
    this.vx = 0;
    this.squash = 0;
    this.flash = 0;
    this.trail = [];
    this.hue = 0;
    this.stretchX = 0;
  }

  get left() { return this.x - this.w / 2; }
  get right() { return this.x + this.w / 2; }
  get top() { return this.y - this.h / 2; }
  get bottom() { return this.y + this.h / 2; }

  aabb() {
    return { x: this.left, y: this.top, w: this.w, h: this.h };
  }

  resize(kind) {
    this.targetW = kind === 'wide' ? PADDLE.wWide : PADDLE.w;
  }

  update(dt, input, playing) {
    const prevX = this.x;
    let target = this.x;

    if (input) {
      // Pointer / touch or keyboard steering, whichever moved last.
      const pointerX = input.x + (input.touchGrab || 0);
      if (input.axis !== 0) target = this.x + input.axis * 1100 * dt;
      else if (input.hasPointer) target = pointerX;
    }
    const half = this.w / 2;
    target = clamp(target, FIELD.x + half, FIELD.x + FIELD.w - half);

    // Exponential follow; snappier while the ball is close to the paddle so
    // last-instant saves feel possible.
    const rate = playing ? PADDLE.follow : PADDLE.follow * 0.7;
    this.x = damp(this.x, target, rate, dt);
    this.x = clamp(this.x, FIELD.x + half, FIELD.x + FIELD.w - half);
    this.vx = (this.x - prevX) / Math.max(1e-4, dt);

    // Width lerp for power-ups
    this.w = damp(this.w, this.targetW, 8, dt);

    // Squash & stretch: impact squash decays, lateral speed stretches it.
    this.squash = damp(this.squash, 0, 9, dt);
    this.flash = damp(this.flash, 0, 6, dt);
    const speed = Math.abs(this.vx);
    this.stretchX = damp(this.stretchX, clamp(speed / 2600, 0, 0.35), 12, dt);
    this.hue = damp(this.hue, 0, 4, dt);

    // Heat trail
    this.trail.push({ x: this.x, w: this.w, a: 1 });
    if (this.trail.length > 9) this.trail.shift();
    for (const s of this.trail) s.a = Math.max(0, s.a - dt * 2.6);
  }

  onHit(strength) {
    this.squash = PADDLE.squash * clamp(strength, 0.4, 1.6);
    this.flash = 1;
    this.hue = 1;
  }

  /**
   * Reflect the ball. Returns the new velocity + the offset used (for VFX).
   * @param {object} ball
   */
  reflect(ball) {
    const offset = clamp((ball.x - this.x) / (this.w / 2), -1, 1);
    const angle = -Math.PI / 2 + offset * PADDLE.maxAngle * DEG;
    const speed = Math.max(ball.speed || Math.hypot(ball.vx, ball.vy), 300);
    // The paddle's own motion adds "english": moving right pushes right.
    const transfer = clamp(this.vx * PADDLE.inertia, -260, 260);
    let vx = Math.cos(angle) * speed + transfer;
    let vy = Math.sin(angle) * speed;
    // Guarantee real vertical progress so we never get a horizontal loop.
    vy = Math.min(vy, -speed * 0.32);
    const mag = Math.hypot(vx, vy) || speed;
    const k = speed / mag;
    ball.vx = vx * k;
    ball.vy = vy * k;
    ball.y = this.top - ball.r - 0.5;
    return { offset, transfer };
  }

  draw(r, t, danger) {
    // --- heat trail
    for (const s of this.trail) {
      if (s.a <= 0.01) continue;
      const k = 1 - s.a;
      r.glowRect(s.x - s.w / 2 * (1 + k * 0.2), this.y - 3, s.w * (1 + k * 0.2), 6,
        mixHex(COLORS.paddle, COLORS.flip, k * 0.5), s.a * 0.12, 4);
    }

    const w = this.w * (1 + this.stretchX - this.squash * 0.35);
    const h = this.h * (1 - this.squash * 0.55);
    const x = this.x - w / 2;
    const y = this.y - h / 2;

    // --- energy core + glow
    const hot = this.flash;
    const coreColor = mixHex(mixHex(COLORS.paddle, '#ffffff', 0.35 * hot), COLORS.danger, danger * 0.35);
    r.halo(this.x, this.y, w * 0.72, coreColor, 0.28 + hot * 0.5, 0.18);

    // --- body
    r.rect(x, y, w, h, { fill: mixHex(COLORS.paddleDeep, '#000000', 0.35), radius: 8 });
    r.rect(x + 1.5, y + 1.5, w - 3, h - 3, { fill: coreColor, radius: 7, alpha: 0.85 });
    r.rect(x + 6, y + 2.5, w - 12, 2.4, { fill: '#ffffff', alpha: 0.75 + hot * 0.25, radius: 2 });

    // --- end caps (the "aim guides")
    r.circle(x + 3, this.y, h * 0.48, { fill: mixHex(coreColor, '#ffffff', 0.5) });
    r.circle(x + w - 3, this.y, h * 0.48, { fill: mixHex(coreColor, '#ffffff', 0.5) });

    // --- squash ripple when it just hit something
    if (this.squash > 0.05) {
      const k = 1 - this.squash / Math.max(0.01, PADDLE.squash);
      const rx = w * (0.5 + easeOutCubic(Math.min(1, k)) * 0.5);
      r.rect(this.x - rx, this.y - 4, rx * 2, 8, {
        stroke: rgba(COLORS.paddle, (1 - k) * 0.8), lw: 2, radius: 4,
      });
    }
  }

  /** Draw the "ready" attractor: where the ball will launch from. */
  drawLaunchHint(r, t, ball) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    r.circle(ball.x, ball.y, ball.r + 6 + pulse * 3, { stroke: rgba(COLORS.accent, 0.5 * (1 - pulse * 0.5)), lw: 1.5 });
    r.line(ball.x, ball.y + ball.r + 4, ball.x, ball.y + ball.r + 16 + pulse * 5,
      { color: rgba(COLORS.accent, 0.55), lw: 2 });
  }
}
