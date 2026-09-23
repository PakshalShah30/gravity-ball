/**
 * particles.js — a fixed-size, allocation-free particle pool.
 *
 * Every effect in the game (brick shrapnel, sparks, shockwaves, smoke, the
 * anti-gravity wind, embers around the ball) is drawn from this single pool,
 * so the framerate never depends on how much the game is exploding.
 *
 * Particles come in five flavours:
 *   spark — additive streak that follows its velocity (impacts, sparks)
 *   shard — rotating quad, the actual debris of a broken brick
 *   puff  — soft additive circle that grows and fades (smoke, glow, light)
 *   ring  — expanding stroked circle (shockwaves)
 *   ember — tiny bright dot that floats and flickers
 */

const SPARK = 0, SHARD = 1, PUFF = 2, RING = 3, EMBER = 4;

class Particle {
  constructor() { this.active = false; }
}

export class Particles {
  constructor(max = 2600) {
    this.max = max;
    this.items = new Array(max);
    for (let i = 0; i < max; i++) this.items[i] = new Particle();
    this.cursor = 0;
    this.live = 0;
    this.rng = Math.random;
  }

  clear() {
    for (let i = 0; i < this.max; i++) this.items[i].active = false;
    this.live = 0;
  }

  /** Grab a slot; recycles the oldest particle when the pool is exhausted. */
  _next() {
    const items = this.items;
    for (let i = 0; i < 24; i++) {
      const p = items[(this.cursor + i) % this.max];
      if (!p.active) { this.cursor = (this.cursor + i + 1) % this.max; this.live++; return p; }
    }
    // Pool is saturated: steal the cursor slot (the newest effects win).
    const p = items[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    return p;
  }

  spawn(kind, x, y, opts = {}) {
    const p = this._next();
    const r = this.rng;
    const spread = opts.spread ?? Math.PI * 2;
    const angle = opts.angle !== undefined ? opts.angle + (r() - 0.5) * spread : r() * Math.PI * 2;
    const speed = opts.speed !== undefined
      ? (Array.isArray(opts.speed) ? opts.speed[0] + r() * (opts.speed[1] - opts.speed[0]) : opts.speed)
      : 0;

    p.active = true;
    p.kind = kind;
    p.x = x + (opts.jitter ? (r() - 0.5) * opts.jitter : 0);
    p.y = y + (opts.jitter ? (r() - 0.5) * opts.jitter : 0);
    p.vx = (opts.vx ?? Math.cos(angle) * speed);
    p.vy = (opts.vy ?? Math.sin(angle) * speed);
    p.life = 0;
    p.maxLife = opts.life ?? 0.6;
    p.size0 = opts.size ?? 3;
    p.size1 = opts.size1 ?? p.size0 * 0.2;
    p.rot = opts.rot ?? r() * Math.PI;
    p.vr = opts.vr ?? (r() - 0.5) * 14;
    p.drag = opts.drag ?? 2.2;
    p.grav = opts.grav ?? 0;
    p.color = opts.color ?? '#fff';
    p.alpha = opts.alpha ?? 1;
    p.glow = opts.glow ?? 0;
    p.spin = opts.spin ?? 1;
    p.wobble = r() * Math.PI * 2;
    return p;
  }

  // ------------------------------------------------------------- emitters ---

  /** Generic radial burst. The workhorse. */
  burst(x, y, o = {}) {
    const n = o.count ?? 12;
    for (let i = 0; i < n; i++) {
      this.spawn(o.kind ?? SPARK, x, y, {
        angle: o.angle, spread: o.spread ?? Math.PI * 2,
        speed: o.speed ?? [120, 420],
        life: (o.life ?? 0.5) * (0.6 + this.rng() * 0.7),
        size: o.size ?? 3.2, size1: o.size1,
        color: o.color, alpha: o.alpha, glow: o.glow,
        drag: o.drag ?? 3.0, grav: o.grav ?? 0, jitter: o.jitter ?? 4,
      });
    }
  }

  /** Brick shrapnel: gravity-affected rotating slabs in the brick's colour. */
  shards(x, y, w, h, color, count = 9) {
    for (let i = 0; i < count; i++) {
      const sx = (this.rng() - 0.5) * w;
      const sy = (this.rng() - 0.5) * h;
      this.spawn(SHARD, x + sx, y + sy, {
        speed: [60, 300], life: [0.5, 1.2],
        size: 3 + this.rng() * 6, size1: 2,
        color, glow: 0.25, drag: 0.9, grav: 1500,
        angle: -Math.PI / 2, spread: Math.PI * 1.1,
      });
    }
  }

  /** Expanding shockwave ring. Instantly readable "something big happened". */
  ring(x, y, color, r0, r1, life = 0.45, width = 3, alpha = 0.9) {
    return this.spawn(RING, x, y, {
      size: r0, size1: r1, life, color, alpha, width, drag: 0,
    });
  }

  /** Soft light puff — feeds the bloom layer nicely. */
  puff(x, y, color, size, life, opts = {}) {
    return this.spawn(PUFF, x, y, {
      size, size1: opts.size1 ?? size * 1.9, life, color,
      alpha: opts.alpha ?? 0.5, glow: opts.glow ?? 1,
      vx: opts.vx ?? 0, vy: opts.vy ?? 0, drag: opts.drag ?? 1.2,
    });
  }

  ember(x, y, color, speed = 40, life = 1.1) {
    return this.spawn(EMBER, x, y, {
      speed: [speed * 0.3, speed], life, size: 2.6, size1: 0.4,
      color, glow: 1, drag: 0.35, grav: -26, alpha: 0.95,
    });
  }

  // ---------------------------------------------------------------- update ---

  update(dt, gravity = 0) {
    const items = this.items;
    for (let i = 0; i < this.max; i++) {
      const p = items[i];
      if (!p.active) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.active = false; this.live--; continue; }

      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy = p.vy * d + (p.grav + gravity * (p.kind === SHARD ? 1 : 0)) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.kind === EMBER) p.x += Math.sin(p.life * 6 + p.wobble) * 14 * dt;
    }
  }

  /** Debris layer: normal alpha blending. */
  drawNormal(ctx) {
    const items = this.items;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < this.max; i++) {
      const p = items[i];
      if (!p.active) continue;
      const t = p.life / p.maxLife;
      if (p.kind === SHARD) {
        const a = p.alpha * (1 - t * t);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        const s = p.size0 * (1 - t * 0.55);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-s * 0.5, -s * 0.36, s, s * 0.72);
        ctx.restore();
      } else if (p.kind === RING) {
        const rr = p.size0 + (p.size1 - p.size0) * (1 - (1 - t) ** 2);
        ctx.globalAlpha = p.alpha * (1 - t) ** 1.6;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = (p.width ?? 3) * (1 - t * 0.7);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.5, rr), 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === SPARK && p.glow < 0.5) {
        drawStreak(ctx, p, t);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** Emissive layer: additive blending, drawn on top of everything. */
  drawAdditive(ctx) {
    const items = this.items;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.max; i++) {
      const p = items[i];
      if (!p.active) continue;
      const t = p.life / p.maxLife;
      switch (p.kind) {
        case SPARK:
          if (p.glow >= 0.5) drawStreak(ctx, p, t);
          break;
        case EMBER:
          ctx.globalAlpha = 0.85 * (1 - t) * (0.7 + 0.3 * Math.sin(p.life * 30));
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size0 * (1 - t * 0.6), 0, Math.PI * 2);
          ctx.fill();
          break;
        case PUFF: {
          // Soft falloff from stacked additive discs (5 shells, quadratic
          // alpha ramp). A per-frame createRadialGradient would be prettier but
          // this is ~free and leaves no visible disc edge, which a 3-shell
          // version did.
          const rr = p.size0 + (p.size1 - p.size0) * t;
          const a = p.alpha * (1 - t) ** 1.7;
          for (let k = 0; k < 5; k++) {
            const f = 1 - k * 0.195;
            ctx.globalAlpha = a * 0.085 * (1 + k);
            ctx.beginPath(); ctx.arc(p.x, p.y, rr * f, 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

}

function drawStreak(ctx, p, t) {
  const a = p.alpha * (1 - t) ** 1.4;
  ctx.globalAlpha = a;
  ctx.strokeStyle = p.color;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(0.7, p.size0 * (1 - t * 0.8));
  const len = 0.035 * p.size0;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x - p.vx * len, p.y - p.vy * len);
  ctx.stroke();
}

