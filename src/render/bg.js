/**
 * bg.js — the arena backdrop: starfield, parallax grid, gravity telegraphs
 * and the shredder pit. It reacts to the game state (combo heat, gravity
 * direction) so the room feels alive even when nothing is being destroyed.
 */
import { TAU, rgba, mixHex, hashNoise, clamp } from '../core/math.js';
import { COLORS, FIELD, VIEW } from '../config.js';

export class Background {
  constructor(rng) {
    this.stars = [];
    for (let i = 0; i < 190; i++) {
      const depth = i < 70 ? 0.25 : i < 140 ? 0.55 : 1;
      this.stars.push({
        x: rng() * VIEW.w, y: rng() * VIEW.h,
        r: depth * 1.5 + rng() * 0.9,
        tw: rng() * TAU, tws: 0.6 + rng() * 2.4,
        depth, hue: rng(),
      });
    }
    this.gridPhase = 0;
    this.heat = 0;
    this.rng = rng;
  }

  update(dt, state) {
    this.gridPhase += dt * 0.14;
    this.heat += ((state.heat ?? 0) - this.heat) * Math.min(1, dt * 3);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} s  {t, dir, intensity, level, ballY, danger}
   */
  draw(ctx, s) {
    const heat = this.heat;

    // ---- deep space gradient (full canvas in virtual space, unshaken) ------
    const g = ctx.createLinearGradient(0, 0, 0, VIEW.h);
    g.addColorStop(0, mixHex(COLORS.bg1, '#2a1140', Math.min(1, heat * 0.5)));
    g.addColorStop(0.55, COLORS.bg0);
    g.addColorStop(1, mixHex('#06101a', '#2b0a1c', Math.min(1, heat * 0.6)));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW.w, VIEW.h);

    // ---- two soft nebula pools so the void has depth ---------------------
    const n1 = ctx.createRadialGradient(190, 150, 0, 190, 150, 420);
    n1.addColorStop(0, rgba('#1d3a6b', 0.5 + heat * 0.1));
    n1.addColorStop(1, rgba('#1d3a6b', 0));
    ctx.fillStyle = n1;
    ctx.fillRect(0, 0, VIEW.w, VIEW.h);

    const n2 = ctx.createRadialGradient(830, 600, 0, 830, 600, 460);
    n2.addColorStop(0, rgba(mixHex('#0b3f4a', '#5a1240', heat), 0.45));
    n2.addColorStop(1, rgba('#0b3f4a', 0));
    ctx.fillStyle = n2;
    ctx.fillRect(0, 0, VIEW.w, VIEW.h);

    // ---- starfield (parallaxes with the shake, twinkles with the beat) ----
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const st of this.stars) {
      const tw = 0.45 + 0.55 * Math.sin(s.t * st.tws + st.tw);
      ctx.globalAlpha = 0.16 + tw * 0.5 * st.depth;
      ctx.fillStyle = st.hue > 0.85 ? '#ffd9a0' : st.hue > 0.6 ? '#a8d8ff' : '#ffffff';
      const r = st.r * (0.7 + tw * 0.5);
      ctx.fillRect(st.x - r * 0.5, st.y - r * 0.5, r, r);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // ---- arena floor grid, brighter toward the pit ------------------------
    ctx.save();
    ctx.strokeStyle = rgba(COLORS.grid, 0.55);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 49;
    const off = (this.gridPhase * step) % step;
    for (let y = FIELD.y + off; y < FIELD.bottom; y += step) {
      ctx.moveTo(FIELD.x, Math.round(y) + 0.5);
      ctx.lineTo(FIELD.x + FIELD.w, Math.round(y) + 0.5);
    }
    for (let x = FIELD.x; x <= FIELD.x + FIELD.w; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, FIELD.y);
      ctx.lineTo(Math.round(x) + 0.5, FIELD.bottom);
    }
    ctx.stroke();
    ctx.restore();

    // ---- horizon glow at the gravity-receiving wall ----------------------
    const active = s.dir < 0 ? 'top' : 'bottom';
    const beam = ctx.createLinearGradient(0, FIELD.y, 0, FIELD.y + 120);
    beam.addColorStop(0, rgba(COLORS.accent, 0.16));
    beam.addColorStop(1, rgba(COLORS.accent, 0));
    if (active === 'top') { ctx.fillStyle = beam; ctx.fillRect(FIELD.x, FIELD.y, FIELD.w, 120); }

    // ---- the shredder pit -------------------------------------------------
    const py = FIELD.bottom;
    const pitH = FIELD.wall + 8;
    const danger = clamp(s.danger ?? 0, 0, 1);
    const pit = ctx.createLinearGradient(0, py, 0, py + pitH);
    const hot = mixHex(COLORS.pit, '#ffd166', danger * 0.5);
    pit.addColorStop(0, rgba(hot, 0.35 + danger * 0.45));
    pit.addColorStop(0.45, rgba(hot, 0.75 + danger * 0.25));
    pit.addColorStop(1, rgba('#5a0a1c', 0.9));
    ctx.fillStyle = pit;
    ctx.fillRect(FIELD.x, py, FIELD.w, pitH);

    // animated hazard chevrons that speed up as the ball approaches
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba('#ff8fa3', 0.35 + danger * 0.5);
    ctx.lineWidth = 2;
    const cw = 26, speed = 90 + danger * 320;
    const ph = ((s.t * speed) % cw);
    ctx.beginPath();
    for (let x = FIELD.x - cw + ph; x < FIELD.x + FIELD.w + cw; x += cw) {
      ctx.moveTo(x, py + pitH - 1);
      ctx.lineTo(x + cw * 0.5, py + 2);
      ctx.lineTo(x + cw, py + pitH - 1);
    }
    ctx.stroke();
    ctx.restore();

    // ---- ceiling rail (the surface you slam into after a flip) -----------
    const ceil = ctx.createLinearGradient(0, FIELD.y + 90, 0, FIELD.y);
    ceil.addColorStop(0, rgba(COLORS.accent, 0));
    ceil.addColorStop(1, rgba(COLORS.accent, s.dir < 0 ? 0.3 : 0.07));
    ctx.fillStyle = ceil;
    ctx.fillRect(FIELD.x, FIELD.y, FIELD.w, 90);

    if (s.dir < 0) {
      // anti-gravity field lines crawling along the ceiling
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(COLORS.flip, 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const x = FIELD.x + ((i * 97 + (s.t * 150) % 97) % FIELD.w);
        const wob = Math.sin(s.t * 4 + i) * 5;
        ctx.moveTo(x, FIELD.y + 2);
        ctx.lineTo(x + wob, FIELD.y + 22 + Math.sin(s.t * 6 + i) * 6);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}
