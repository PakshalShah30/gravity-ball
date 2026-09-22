/**
 * renderer.js — canvas plumbing + the drawing vocabulary the game speaks.
 *
 * Wraps Canvas2D in a fixed virtual resolution (1000x760, letterboxed to the
 * window) so every physics number in config.js is resolution independent, and
 * adds the "juice primitives": additive halos, rounded rects, styled text,
 * plus the CRT post-processing pass (bloom-ish halos, scanlines, vignette,
 * chromatic fringes, screen flash).
 *
 * Glow strategy: instead of blurring the framebuffer every frame (expensive,
 * and a filter on the hot path), emissive objects draw an additive radial
 * halo behind themselves. Overlapping halos accumulate into real light bloom
 * for free, which is exactly the look we want.
 */
import { clamp, rgba, hexToRgb } from '../core/math.js';
import { VIEW, COLORS, JUICE } from '../config.js';

const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = 1;
    this.scale = 1;
    this.offX = 0;
    this.offY = 0;
    this.w = VIEW.w;
    this.h = VIEW.h;
    this.gradients = 0;      // budget counter, reset in begin()
    this.maxGradients = 260; // guards the per-frame gradient allocation cost
    this.scanlinesOn = true;
    this.shakeEnabled = true;
    this.resize();
  }

  resize() {
    const canvas = this.canvas;
    const dpr = this.dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth || globalThis.innerWidth || VIEW.w;
    const ch = canvas.clientHeight || globalThis.innerHeight || VIEW.h;
    canvas.width = Math.max(2, Math.round(cw * dpr));
    canvas.height = Math.max(2, Math.round(ch * dpr));
    const s = this.scale = Math.min(canvas.width / VIEW.w, canvas.height / VIEW.h);
    this.offX = (canvas.width - VIEW.w * s) / 2;
    this.offY = (canvas.height - VIEW.h * s) / 2;
  }

  /** Screen (client) pixels -> virtual game coordinates. */
  toVirtual(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const dpr = this.dpr;
    const x = (clientX - (r.left || 0)) * dpr;
    const y = (clientY - (r.top || 0)) * dpr;
    return { x: (x - this.offX) / this.scale, y: (y - this.offY) / this.scale };
  }

  /** Virtual game coordinates -> screen pixels (for DOM/overlay work). */
  toScreen(x, y) {
    return { x: (x * this.scale + this.offX) / this.dpr, y: (y * this.scale + this.offY) / this.dpr };
  }

  get cssScale() { return this.scale / this.dpr; }

  // ------------------------------------------------------------- framing ---

  _baseTransform() {
    const ctx = this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offX, this.offY);
  }

  /** Start a frame: backdrop, virtual transform, camera shake. */
  begin(fx, shakeRotPivot) {
    const ctx = this.ctx;
    this.gradients = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // The letterbox area gets the same deep space colour as the playfield.
    ctx.fillStyle = COLORS.bg0;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this._baseTransform();
    this.pivot = shakeRotPivot;
    this.applyShake(fx);
  }

  applyShake(fx) {
    const ctx = this.ctx;
    this._baseTransform();
    if (!fx || !this.shakeEnabled) return;
    const px = this.pivot ? this.pivot.x : VIEW.w / 2;
    const py = this.pivot ? this.pivot.y : VIEW.h / 2;
    ctx.translate(px + fx.shakeX, py + fx.shakeY);
    if (fx.shakeRot) ctx.rotate(fx.shakeRot);
    ctx.translate(-px, -py);
  }

  /** HUD space: virtual coordinates, no shake. */
  beginHud() {
    this._baseTransform();
  }

  // ---------------------------------------------------------- primitives ---

  /**
   * Additive halo — the core of the glow look. `r` is the radius at which the
   * light has fully faded out.
   */
  halo(x, y, r, color, alpha = 0.8, core = 0) {
    if (alpha <= 0.004 || r <= 0) return;
    const ctx = this.ctx;
    if (this.gradients < this.maxGradients) {
      this.gradients++;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(color, alpha));
      g.addColorStop(core, rgba(color, alpha * 0.55));
      g.addColorStop(1, rgba(color, 0));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    // Budget exhausted: cheap additive blobs still read as light.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * 0.5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  glowRect(x, y, w, h, color, alpha = 0.8, spread = 10) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(x - spread, y - spread, w + spread * 2, h + spread * 2);
    ctx.globalAlpha = alpha * 0.9;
    ctx.fillRect(x - spread * 0.4, y - spread * 0.4, w + spread * 0.8, h + spread * 0.8);
    ctx.restore();
  }

  rect(x, y, w, h, o = {}) {
    const ctx = this.ctx;
    const r = Math.min(o.radius ?? 0, w * 0.5, h * 0.5);
    ctx.save();
    ctx.globalAlpha = o.alpha ?? 1;
    if (r > 0.5) this._roundPath(ctx, x, y, w, h, r);
    else ctx.beginPath(), ctx.rect(x, y, w, h);
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
    if (o.stroke) {
      ctx.strokeStyle = o.stroke;
      ctx.lineWidth = o.lw ?? 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  circle(x, y, r, o = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = o.alpha ?? 1;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.2, r), 0, Math.PI * 2);
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
    if (o.stroke) { ctx.strokeStyle = o.stroke; ctx.lineWidth = o.lw ?? 2; ctx.stroke(); }
    ctx.restore();
  }

  line(x1, y1, x2, y2, o = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = o.alpha ?? 1;
    ctx.strokeStyle = o.color ?? '#fff';
    ctx.lineWidth = o.lw ?? 2;
    ctx.lineCap = o.cap ?? 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  poly(points, o = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = o.alpha ?? 1;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
    if (o.stroke) {
      ctx.strokeStyle = o.stroke;
      ctx.lineWidth = o.lw ?? 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }

  _roundPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // --------------------------------------------------------------- text ---

  font(size, weight = 700, mono = true) {
    return `${weight} ${size}px ${mono ? MONO : SANS}`;
  }

  measure(str, size, weight = 700, mono = true) {
    const ctx = this.ctx;
    ctx.font = this.font(size, weight, mono);
    const m = ctx.measureText ? ctx.measureText(str) : null;
    // Fallback for environments without real text metrics.
    return m && m.width ? m.width : str.length * size * 0.58;
  }

  /** Width of a string laid out with fake letter-spacing. */
  measureTracked(str, size, weight, mono, tracking) {
    const ctx = this.ctx;
    ctx.font = this.font(size, weight, mono);
    let w = 0;
    for (let i = 0; i < str.length; i++) w += this.measure(str[i], size, weight, mono) + tracking;
    return Math.max(0, w - tracking);
  }

  /**
   * Styled text. `tracking` fakes letter-spacing (canvas has none), `glow`
   * draws a thick translucent stroke behind the fill for a neon sign look.
   */
  text(str, x, y, o = {}) {
    const ctx = this.ctx;
    const size = o.size ?? 20;
    ctx.save();
    ctx.font = this.font(size, o.weight ?? 700, o.mono ?? true);
    ctx.textAlign = o.align ?? 'left';
    ctx.textBaseline = o.baseline ?? 'alphabetic';
    ctx.globalAlpha = o.alpha ?? 1;

    const track = o.tracking ?? 0;
    // Measure exactly the way the glyphs are laid out below (per character +
    // tracking) so centred/right-aligned tracked text lands where it should.
    const total = track ? this.measureTracked(str, size, o.weight ?? 700, o.mono ?? true, track) : 0;
    let sx = x;
    if (track && (o.align ?? 'left') === 'center') sx = x - total / 2;
    if (track && (o.align ?? 'left') === 'right') sx = x - total;

    ctx.translate(sx, y);
    if (o.rot) ctx.rotate(o.rot);
    if (o.scaleX || o.scaleY) ctx.scale(o.scaleX ?? 1, o.scaleY ?? 1);

    if (o.glow) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      ctx.lineWidth = (o.glowWidth ?? size * 0.4);
      ctx.globalAlpha = (o.alpha ?? 1) * 0.5 * (o.glowAmt ?? 1);
      ctx.strokeStyle = o.glowColor ?? o.color ?? COLORS.text;
      this._fillChars(ctx, str, size, track, o, true);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = o.alpha ?? 1;
    }
    if (o.stroke) {
      ctx.lineWidth = o.lw ?? 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = o.stroke;
      this._fillChars(ctx, str, size, track, o, true);
    }
    ctx.fillStyle = o.color ?? COLORS.text;
    this._fillChars(ctx, str, size, track, o, false);
    ctx.restore();
    return total || this.measure(str, size, o.weight ?? 700, o.mono ?? true);
  }

  _fillChars(ctx, str, size, track, o, stroke) {
    if (!track) {
      stroke ? ctx.strokeText(str, 0, 0) : ctx.fillText(str, 0, 0);
      return;
    }
    let x = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      stroke ? ctx.strokeText(ch, x, 0) : ctx.fillText(ch, x, 0);
      x += this.measure(ch, size, o.weight ?? 700, o.mono ?? true) + track;
    }
  }

  // -------------------------------------------------------- post process ---

  /** Full-screen colour flash (explosions, damage, level clear). */
  flash(amount, color) {
    if (amount <= 0.002) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, amount);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }

  scanlines(strength = JUICE.scanlines) {
    if (!this.scanlinesOn) return;
    const ctx = this.ctx;
    const step = Math.max(2, Math.round(3 * this.dpr));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = strength;
    ctx.fillStyle = '#000000';
    for (let y = 0; y < this.canvas.height; y += step) {
      ctx.fillRect(0, y, this.canvas.width, 1);
    }
    ctx.restore();
  }

  vignette(strength = JUICE.vignette, tint = 0) {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const g = ctx.createRadialGradient(w / 2, h * 0.46, Math.min(w, h) * 0.28, w / 2, h * 0.5, Math.max(w, h) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${clamp(strength, 0, 1)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (tint > 0) {
      const t = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
      t.addColorStop(0, 'rgba(255,60,90,0)');
      t.addColorStop(1, `rgba(255,40,80,${clamp(tint, 0, 1)})`);
      ctx.fillStyle = t;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  /**
   * Chromatic fringe: on huge impacts the whole scene gets a red/blue ghost.
   * Drawn as two additive offset copies of a soft full-screen gradient so it
   * stays a 2-drawcall effect.
   */
  chromatic(amount) {
    if (amount <= 0.01) return;
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    const d = Math.max(4, amount * 26 * this.dpr);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(0.55, amount * 0.6);
    const band = (x, y, bw, bh, from, to, color) => {
      const g = ctx.createLinearGradient(x, y, to === 'x' ? x + bw : x, to === 'y' ? y + bh : y);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, bw, bh);
    };
    // red fringe pulled outward, cyan fringe pulled inward: a lens split.
    band(0, 0, d, h, 0, 'x', 'rgba(255,20,60,1)');
    band(w - d, 0, d, h, 0, 'x', 'rgba(255,20,60,1)');
    const g2 = ctx.createLinearGradient(w - d, 0, w, 0);
    g2.addColorStop(0, 'rgba(0,170,255,0)');
    g2.addColorStop(1, 'rgba(0,170,255,1)');
    ctx.fillStyle = g2;
    ctx.fillRect(w - d, 0, d, h);
    const g3 = ctx.createLinearGradient(d, 0, 0, 0);
    g3.addColorStop(0, 'rgba(0,170,255,0)');
    g3.addColorStop(1, 'rgba(0,170,255,1)');
    ctx.fillStyle = g3;
    ctx.fillRect(0, 0, d, h);
    ctx.restore();
  }

  /** Grain: a sparse dither pattern that kills gradient banding. */
  grain(amount, t) {
    if (amount <= 0.002) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = amount * (0.5 + 0.5 * Math.abs(Math.sin(t * 13.7)));
    ctx.fillStyle = '#ffffff';
    const w = this.canvas.width, h = this.canvas.height;
    for (let i = 0; i < 220; i++) {
      const x = (Math.sin(i * 12.9898 + t * 4.1) * 43758.5453) % 1;
      const y = (Math.sin(i * 78.233 + t * 3.7) * 43758.5453) % 1;
      ctx.fillRect((x < 0 ? x + 1 : x) * w, (y < 0 ? y + 1 : y) * h, 1, 1);
    }
    ctx.restore();
  }

  get cssWidth() { return this.canvas.width / this.dpr; }
  get cssHeight() { return this.canvas.height / this.dpr; }
}

export { MONO, SANS };
