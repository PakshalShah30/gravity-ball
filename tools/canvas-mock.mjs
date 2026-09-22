/**
 * canvas-mock.mjs — a software Canvas2D implementation for headless testing.
 *
 * Why: the sandbox has no browser, but "does it run and does it look right"
 * still needs an answer. This implements the exact subset of the Canvas2D API
 * the game is allowed to touch, rasterizes it in JavaScript and writes PNGs,
 * so the test harness can screenshot the real game.
 *
 * It also *audits* API usage: touching a canvas feature that is not part of
 * the documented subset throws (or warns, for deliberately unsupported ones),
 * which catches browser-compatibility accidents at test time.
 */

const UNSUPPORTED = new Set([
  'drawImage', 'createPattern', 'getImageData', 'putImageData', 'createImageData',
  'ellipse', 'clip', 'roundRect', 'filter', 'letterSpacing', 'wordSpacing',
  'resetTransform', 'isPointInPath', 'isPointInStroke', 'setLineDash', 'getLineDash',
  'arcTo', 'bezierCurveTo', 'strokeText', 'fillText',
]);

export function installCanvasMock(opts = {}) {
  let W = opts.width ?? 1000;
  let H = opts.height ?? 760;
  const RS = opts.rasterScale ?? 0.72;
  // The framebuffer follows the canvas backing store, so setViewport() can be
  // used to test any screen size and still produce a correct screenshot.
  let RW = Math.max(1, Math.round(W * RS));
  let RH = Math.max(1, Math.round(H * RS));
  let buf = new Uint8ClampedArray(RW * RH * 3);
  const warnings = new Map();
  const audit = { missing: new Set(), unsupported: new Set(), invalidColors: new Set(), clipCount: 0 };
  const rast = { on: true };   // rasterization can be disabled for fast runs
  const winListeners = new Map();
  const docListeners = new Map();

  let clock = 0;
  const rafQueue = [];
  const listeners = new Map();

  const add = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };

  // ------------------------------------------------------------------ state ---
  const st = {
    fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt',
    lineJoin: 'miter', miterLimit: 10, globalAlpha: 1, globalCompositeOperation: 'source-over',
    font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    shadowBlur: 0, shadowColor: '#000', shadowOffsetX: 0, shadowOffsetY: 0,
    filter: 'none', imageSmoothingEnabled: true, lineDashOffset: 0, direction: 'ltr',
  };
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let path = [];       // array of subpaths; each is { pts: [[x,y],...], closed: bool }
  let cur = null;

  const mul = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const apply = (p, mm = m) => [mm[0] * p[0] + mm[2] * p[1] + mm[4], mm[1] * p[0] + mm[3] * p[1] + mm[5]];
  const devScale = (mm = m) => (Math.hypot(mm[0], mm[1]) + Math.hypot(mm[2], mm[3])) / 2;

  // ----------------------------------------------------------------- colors ---
  const rgbCache = new Map();

  /**
   * Parse a CSS colour. Anything unrecognised is recorded in
   * audit.invalidColors and rendered magenta: in a real browser an invalid
   * fillStyle is *silently ignored* (the previous colour stays), which is a
   * spectacularly hard bug to find, so the harness fails loudly instead.
   */
  function parseColor(c) {
    if (typeof c !== 'string') {
      if (c && c.__gradient) return gradColor(c);
      audit.invalidColors.add(String(c));
      return [255, 0, 255, 1];
    }
    let v = rgbCache.get(c);
    if (v) return v;
    v = null;
    const s = c.trim().toLowerCase();
    if (s[0] === '#') {
      const hex = s.slice(1);
      if (hex.length === 3 && /^[0-9a-f]{3}$/.test(hex)) {
        v = [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16), 1];
      } else if (/^[0-9a-f]{6}$/.test(hex)) {
        v = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
      }
    } else if (/^rgba?\(/.test(s)) {
      const nums = s.replace(/[^0-9.]+/g, ' ').trim().split(/\s+/).map(Number);
      if (nums.length >= 3 && nums.every((n) => Number.isFinite(n))) {
        v = [nums[0] | 0, nums[1] | 0, nums[2] | 0, nums.length > 3 ? nums[3] : 1];
      }
    } else if (s === 'white') v = [255, 255, 255, 1];
    else if (s === 'black') v = [0, 0, 0, 1];
    else if (s === 'transparent') v = [0, 0, 0, 0];

    if (!v) {
      audit.invalidColors.add(c);
      v = [255, 0, 255, 1];
    }
    rgbCache.set(c, v);
    return v;
  }

  function gradColor(g) {
    // Rasterize a gradient as its alpha-weighted mean colour.
    let r = 0, gg = 0, b = 0, a = 0, wsum = 0;
    for (let i = 0; i < g.stops.length; i++) {
      const s0 = g.stops[i];
      const s1 = g.stops[i + 1];
      const w = s1 ? Math.max(0.05, s1[0] - s0[0]) : 0.15;
      const c = parseColor(s0[1]);
      r += c[0] * c[3] * w; gg += c[1] * c[3] * w; b += c[2] * c[3] * w;
      a += c[3] * w; wsum += w;
    }
    if (!wsum) return [0, 0, 0, 0];
    return [r / wsum / Math.max(0.001, a / wsum), gg / wsum / Math.max(0.001, a / wsum), b / wsum / Math.max(0.001, a / wsum), a / wsum];
  }

  // ------------------------------------------------------------- rasterizer ---
  function blendPixel(ix, iy, r, g, b, alpha, mode) {
    if (alpha <= 0.004 || !rast.on) return;
    if (ix < 0 || iy < 0 || ix >= RW || iy >= RH) return;
    const i = (iy * RW + ix) * 3;
    if (mode === 'lighter' || mode === 'screen' || mode === 'plus-lighter') {
      buf[i] = Math.min(255, buf[i] + r * alpha);
      buf[i + 1] = Math.min(255, buf[i + 1] + g * alpha);
      buf[i + 2] = Math.min(255, buf[i + 2] + b * alpha);
    } else {
      const ia = 1 - alpha;
      buf[i] = buf[i] * ia + r * alpha;
      buf[i + 1] = buf[i + 1] * ia + g * alpha;
      buf[i + 2] = buf[i + 2] * ia + b * alpha;
    }
  }

  /** Even-odd scanline fill of device-space subpaths. */
  function fillPolys(subpaths, color, mode, alpha) {
    if (!rast.on) return;
    const [r, g, b, ca] = color;
    const a = alpha * ca;
    if (a <= 0.004) return;
    const edges = [];
    let minY = Infinity, maxY = -Infinity;
    for (const sp of subpaths) {
      const pts = sp.pts;
      if (pts.length < 2) continue;
      const n = pts.length;
      const count = sp.closed ? n : n - 1;
      for (let i = 0; i < count; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) % n];
        if (p0[1] === p1[1]) continue;
        edges.push([p0, p1]);
        if (p0[1] < minY) minY = p0[1];
        if (p1[1] < minY) minY = p1[1];
        if (p0[1] > maxY) maxY = p0[1];
        if (p1[1] > maxY) maxY = p1[1];
      }
    }
    if (!edges.length) return;
    let y0 = Math.max(0, Math.floor(minY * RS));
    let y1 = Math.min(RH - 1, Math.ceil(maxY * RS));
    if (y1 < y0) return;
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      const sy = (y + 0.5) / RS;
      xs.length = 0;
      for (let i = 0; i < edges.length; i++) {
        const [p0, p1] = edges[i];
        const yy0 = p0[1], yy1 = p1[1];
        if ((sy >= yy0 && sy < yy1) || (sy >= yy1 && sy < yy0)) {
          xs.push(p0[0] + (sy - yy0) / (yy1 - yy0) * (p1[0] - p0[0]));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.round(xs[i] * RS));
        const xb = Math.min(RW - 1, Math.round(xs[i + 1] * RS));
        for (let x = xa; x <= xb; x++) blendPixel(x, y, r, g, b, a, mode);
      }
    }
  }

  function strokePolys(subpaths, color, mode, alpha, lw, cap) {
    if (!rast.on) return;
    const hw = Math.max(0.35, lw / 2);
    for (const sp of subpaths) {
      const pts = sp.pts;
      const closed = sp.closed && pts.length > 2;
      const n = pts.length;
      const count = closed ? n : n - 1;
      for (let i = 0; i < count; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) % n];
        const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
        const len = Math.hypot(dx, dy);
        if (len < 0.01) continue;
        const nx = -dy / len * hw, ny = dx / len * hw;
        fillPolys([{ pts: [[p0[0] + nx, p0[1] + ny], [p1[0] + nx, p1[1] + ny], [p1[0] - nx, p1[1] - ny], [p0[0] - nx, p0[1] - ny]], closed: true }],
          color, mode, alpha);
        if (cap === 'round') {
          fillPolys([circlePts(p0[0], p0[1], hw)], color, mode, alpha);
          fillPolys([circlePts(p1[0], p1[1], hw)], color, mode, alpha);
        }
      }
      if (closed && pts.length > 2 && cap === 'round') {
        // nothing more needed: segments already include the closing edge
      }
    }
  }

  function circlePts(x, y, r, seg = 16) {
    const pts = [];
    const n = Math.max(6, Math.min(28, seg || Math.ceil(r * 1.2)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
    return { pts, closed: true };
  }

  // ---------------------------------------------------------------- the ctx ---
  function beginSub(p) { cur = { pts: [p], closed: false }; path.push(cur); }
  function lineToP(p) { if (!cur) beginSub(p); else cur.pts.push(p); }

  function flattenQuad(p0, cp, p1, out) {
    const N = 8;
    for (let i = 1; i <= N; i++) {
      const t = i / N, it = 1 - t;
      out.push([
        it * it * p0[0] + 2 * it * t * cp[0] + t * t * p1[0],
        it * it * p0[1] + 2 * it * t * cp[1] + t * t * p1[1],
      ]);
    }
  }

  function currentPoint() {
    if (cur && cur.pts.length) return cur.pts[cur.pts.length - 1];
    return [0, 0];
  }

  const impl = {
    save() { stack.push({ ...st, m: m.slice() }); if (stack.length > 64) stack.shift(); },
    restore() {
      const s = stack.pop();
      if (!s) return;
      Object.assign(st, s);
      m = s.m;
    },
    translate(x, y) { m = mul(m, [1, 0, 0, 1, x, y]); },
    scale(x, y) { m = mul(m, [x, 0, 0, y, 0, 0]); },
    rotate(a) { const c = Math.cos(a), s = Math.sin(a); m = mul(m, [c, s, -s, c, 0, 0]); },
    transform(a, b, c, d, e, f) { m = mul(m, [a, b, c, d, e, f]); },
    setTransform(a, b, c, d, e, f) { m = [a, b, c, d, e, f]; },
    resetTransform() { m = [1, 0, 0, 1, 0, 0]; },
    getTransform() { return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }; },

    beginPath() { path = []; cur = null; },
    moveTo(x, y) { beginSub([x, y]); },
    lineTo(x, y) { lineToP([x, y]); },
    quadraticCurveTo(cx, cy, x, y) {
      const p0 = currentPoint();
      flattenQuad(p0, [cx, cy], [x, y], cur.pts);
    },
    closePath() { if (cur) cur.closed = true; },
    rect(x, y, w, h) {
      path.push({ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true });
      cur = null;
    },
    arc(x, y, r, a0, a1, ccw) {
      const full = Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6;
      const n = Math.max(8, Math.min(48, Math.ceil((full ? Math.PI * 2 : Math.abs(a1 - a0)) * Math.max(3, r * 0.9))));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + (a1 - a0) * (i / n) * (ccw ? 1 : 1);
        pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
      }
      if (!cur || cur.closed) beginSub(pts[0]);
      else cur.pts.push(pts[0]);
      for (let i = 1; i < pts.length; i++) cur.pts.push(pts[i]);
      if (full) cur.closed = true;
    },

    fill() {
      const subs = path.map((sp) => ({ pts: sp.pts.map((p) => apply(p)), closed: fullClose(sp) }));
      fillPolys(subs, resolveFill(), st.globalCompositeOperation, st.globalAlpha);
    },
    stroke() {
      const lw = st.lineWidth * devScale();
      const subs = path.map((sp) => ({ pts: sp.pts.map((p) => apply(p)), closed: fullClose(sp) }));
      strokePolys(subs, resolveFill(true), st.globalCompositeOperation, st.globalAlpha, lw, st.lineCap);
    },
    fillRect(x, y, w, h) {
      const p = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((q) => apply(q));
      // fast path for axis-aligned rects
      const axisAligned = Math.abs(p[0][1] - p[1][1]) < 1e-6 && Math.abs(p[1][0] - p[2][0]) < 1e-6;
      if (axisAligned && st.globalAlpha > 0.99 && isSolid(st.fillStyle)) {
        const c = parseColor(st.fillStyle);
        const x0 = Math.max(0, Math.round(Math.min(p[0][0], p[2][0]) * RS));
        const x1 = Math.min(RW - 1, Math.round(Math.max(p[0][0], p[2][0]) * RS) - 1);
        const y0 = Math.max(0, Math.round(Math.min(p[0][1], p[2][1]) * RS));
        const y1 = Math.min(RH - 1, Math.round(Math.max(p[0][1], p[2][1]) * RS) - 1);
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) blendPixel(xx, yy, c[0], c[1], c[2], c[3], st.globalCompositeOperation);
        return;
      }
      fillPolys([{ pts: p, closed: true }], resolveFill(), st.globalCompositeOperation, st.globalAlpha);
    },
    strokeRect(x, y, w, h) {
      const lw = st.lineWidth * devScale();
      const p = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((q) => apply(q));
      strokePolys([{ pts: p, closed: true }], resolveFill(true), st.globalCompositeOperation, st.globalAlpha, lw, st.lineCap);
    },
    clearRect(x, y, w, h) {
      const x0 = Math.max(0, Math.round(Math.min(x, x + w) * RS)), x1 = Math.min(RW - 1, Math.round(Math.max(x, x + w) * RS));
      const y0 = Math.max(0, Math.round(Math.min(y, y + h) * RS)), y1 = Math.min(RH - 1, Math.round(Math.max(y, y + h) * RS));
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        const i = (yy * RW + xx) * 3;
        buf[i] = buf[i + 1] = buf[i + 2] = 0;
      }
    },
    fillText(str, x, y) { drawText(str, x, y, false); },
    strokeText(str, x, y) { drawText(str, x, y, true); },
    measureText(str) {
      const size = fontSize(st.font);
      const mono = /mono/i.test(st.font);
      let w = 0;
      for (const ch of String(str)) w += (ch === ' ' ? 0.5 : mono ? 0.6 : 0.56) * size;
      return { width: w, actualBoundingBoxAscent: size * 0.72, actualBoundingBoxDescent: size * 0.2 };
    },
    createLinearGradient(x0, y0, x1, y1) { return { __gradient: 'linear', x0, y0, x1, y1, stops: [], addColorStop: function (o, c) { this.stops.push([o, c]); } }; },
    createRadialGradient(x0, y0, r0, x1, y1, r1) { return { __gradient: 'radial', x0, y0, r0, x1, y1, r1, stops: [], addColorStop: function (o, c) { this.stops.push([o, c]); } }; },
    clip() { audit.clipCount++; warnOnce('clip', 'ctx.clip() is not part of the supported subset'); },
    ellipse() { warnOnce('ellipse', 'ctx.ellipse() is not supported by the harness'); },
    drawImage() { warnOnce('drawImage', 'ctx.drawImage() is not supported by the harness'); },
    setLineDash() { /* not used by the game */ },
    getLineDash() { return []; },
    arcTo() { warnOnce('arcTo', 'ctx.arcTo() not supported'); },
    bezierCurveTo(cx1, cy1, cx2, cy2, x, y) {
      const p0 = currentPoint();
      const N = 10;
      for (let i = 1; i <= N; i++) {
        const t = i / N, it = 1 - t;
        cur.pts.push([
          it ** 3 * p0[0] + 3 * it * it * t * cx1 + 3 * it * t * t * cx2 + t ** 3 * x,
          it ** 3 * p0[1] + 3 * it * it * t * cy1 + 3 * it * t * t * cy2 + t ** 3 * y,
        ]);
      }
    },
  };

  function fullClose(sp) { return sp.closed || sp.pts.length > 2; }
  function isSolid(c) { return typeof c === 'string'; }
  function resolveFill(isStroke) {
    const c = isStroke ? st.strokeStyle : st.fillStyle;
    return parseColor(c);
  }

  function fontSize(font) {
    const mm = /(\d+(?:\.\d+)?)px/.exec(font || '10px');
    return mm ? parseFloat(mm[1]) : 10;
  }

  function drawText(str, x, y, isStroke) {
    if (!rast.on) return;
    // Text is approximated by a translucent box of the right size so layout
    // problems (overlaps, off-screen text) are visible in screenshots.
    const size = fontSize(st.font);
    const w = impl.measureText(str).width;
    let ox = 0;
    if (st.textAlign === 'center') ox = -w / 2;
    else if (st.textAlign === 'right' || st.textAlign === 'end') ox = -w;
    let oy = 0;
    if (st.textBaseline === 'middle') oy = -size * 0.5;
    else if (st.textBaseline === 'top') oy = 0;
    else if (st.textBaseline === 'bottom') oy = -size;
    else oy = -size * 0.78;
    if (!str.length) return;
    const c = isStroke ? parseColor(st.strokeStyle) : parseColor(st.fillStyle);
    const a = st.globalAlpha * (isStroke ? 0.28 : 0.72) * c[3];
    const mode = st.globalCompositeOperation === 'lighter' ? 'lighter' : 'source-over';

    // Approximate glyphs with a 3-row "ink" pattern per character: enough of a
    // texture that alignment, overlap and clipping problems are visible in a
    // screenshot, without shipping a real font rasterizer.
    let cx = x + ox;
    for (const ch of String(str)) {
      const cw = impl.measureText(ch).width;
      if (ch !== ' ') {
        const bands = [
          [0.10, 0.26, 0.16, 0.86],   // ascender row
          [0.40, 0.60, 0.08, 0.94],   // x-height row
          [0.74, 0.90, 0.20, 0.78],   // descender row
        ];
        for (const [t0, t1, l, r] of bands) {
          const q0 = apply([cx + cw * l, y + oy + size * t0]);
          const q1 = apply([cx + cw * r, y + oy + size * t1]);
          const x0 = Math.round(Math.min(q0[0], q1[0]) * RS), x1 = Math.round(Math.max(q0[0], q1[0]) * RS);
          const y0 = Math.round(Math.min(q0[1], q1[1]) * RS), y1 = Math.round(Math.max(q0[1], q1[1]) * RS);
          for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) blendPixel(xx, yy, c[0], c[1], c[2], a, mode);
        }
      }
      cx += cw;
    }
  }

  function warnOnce(key, msg) {
    if (warnings.has(key)) return;
    warnings.set(key, msg);
    audit.unsupported.add(key);
    if (opts.verboseWarnings !== false) console.warn('[canvas-mock] ' + msg);
  }

  const ctx = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in st) return st[prop];
      if (prop === 'canvas') return canvas;
      if (typeof prop === 'symbol') return undefined;
      if (UNSUPPORTED.has(prop)) {
        warnOnce(prop, `unsupported canvas API used: ctx.${String(prop)}`);
        return () => 0;
      }
      audit.missing.add(prop);
      throw new Error(`canvas-mock: canvas context has no property '${String(prop)}' (add it to the supported subset)`);
    },
    set(target, prop, value) {
      if (prop in st || prop in target || typeof value !== 'function') {
        st[prop] = value;
        return true;
      }
      throw new Error(`canvas-mock: cannot assign method '${String(prop)}'`);
    },
  });

  const canvas = {
    width: W, height: H,
    clientWidth: W, clientHeight: H,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H }),
    addEventListener: add(listeners),
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
    appendChild() {},
  };

  // ------------------------------------------------------------- DOM shims ---
  globalThis.document = {
    getElementById: (id) => (id === 'stage' ? canvas : { style: {}, appendChild() {}, addEventListener() {}, classList: canvas.classList }),
    querySelector: () => canvas,
    createElement: () => canvas,
    addEventListener: add(docListeners),
    removeEventListener() {},
    hidden: false,
    body: { appendChild() {}, style: {}, classList: canvas.classList },
    documentElement: { style: {} },
  };
  globalThis.window = globalThis;
  globalThis.devicePixelRatio = opts.dpr ?? 1;
  globalThis.innerWidth = W;
  globalThis.innerHeight = H;
  globalThis.performance = { now: () => clock * 1000 };
  globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.addEventListener = add(winListeners);
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };

  // --------------------------------------------------------------- helpers ---
  const api = {
    canvas, ctx,
    get buf() { return buf; },
    get RW() { return RW; },
    get RH() { return RH; },

    /** Advance the clock and run one animation frame. */
    step(dt = 1 / 60, count = 1) {
      for (let i = 0; i < count; i++) {
        clock += dt;
        const q = rafQueue.splice(0, rafQueue.length);
        if (!q.length) throw new Error('harness: no animation frame queued — did the game stop?');
        for (const cb of q) cb(clock * 1000);
      }
      return api;
    },

    get clock() { return clock; },

    /** Dispatch a pointer event to the canvas listeners. */
    pointer(type, x, y, extra = {}) {
      const ev = {
        clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1,
        preventDefault() {}, stopPropagation() {},
        ...extra,
      };
      for (const fn of listeners.get(type) ?? []) fn(ev);
      return api;
    },

    key(type, code, extra = {}) {
      const ev = { code, key: code, repeat: false, preventDefault() {}, ...extra };
      for (const fn of (winListeners.get(type) ?? [])) fn(ev);
      return api;
    },

    /**
     * Simulate a full tap: down + up (the game treats taps as the primary action).
     */
    tap(x = 500, y = 400) {
      api.pointer('pointerdown', x, y);
      api.pointer('pointerup', x, y);
      return api;
    },

    setRasterize(on) { rast.on = !!on; },

    /**
     * Resize the fake viewport and fire the window resize listener, so layout
     * maths (letterboxing, DPR, pointer mapping) can be tested at any size.
     */
    setViewport(w, h, dpr = 1) {
      canvas.clientWidth = w;
      canvas.clientHeight = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      W = w; H = h;
      RW = Math.max(1, Math.round(canvas.width * RS));
      RH = Math.max(1, Math.round(canvas.height * RS));
      buf = new Uint8ClampedArray(RW * RH * 3);
      globalThis.devicePixelRatio = dpr;
      globalThis.innerWidth = w;
      globalThis.innerHeight = h;
      for (const fn of (winListeners.get('resize') ?? [])) fn({});
      for (const fn of (listeners.get('resize') ?? [])) fn({});
      return api;
    },
    get audit() { return audit; },
    get warnings() { return [...warnings.values()]; },
    get pixelData() { return buf; },
    get size() { return { W: canvas.clientWidth, H: canvas.clientHeight, RW, RH, RS, dpr: globalThis.devicePixelRatio }; },
  };

  return api;
}

// ------------------------------------------------------------------- PNG ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStore(data) {
  const out = [];
  out.push(0x78, 0x01);
  let i = 0;
  while (i < data.length) {
    const len = Math.min(65535, data.length - i);
    const last = i + len >= data.length ? 1 : 0;
    out.push(last, len & 0xff, (len >> 8) & 0xff, ~len & 0xff, (~len >> 8) & 0xff);
    for (let j = 0; j < len; j++) out.push(data[i + j]);
    i += len;
  }
  const a = adler32(data);
  out.push((a >> 24) & 0xff, (a >> 16) & 0xff, (a >> 8) & 0xff, a & 0xff);
  return new Uint8Array(out);
}

/**
 * Write a cropped (optionally nearest-neighbour zoomed) region of the RGB
 * framebuffer to a PNG — used to eyeball small details like the ball or HUD.
 */
export function writePngCrop(filePath, fb, RW, RH, crop, zoomIn = 2, fs) {
  const zoom = Math.max(1, Math.round(zoomIn));   // integer nearest-neighbour zoom
  const x0 = Math.max(0, Math.round(crop.x));
  const y0 = Math.max(0, Math.round(crop.y));
  const w = Math.max(1, Math.min(Math.round(crop.w), RW - x0));
  const h = Math.max(1, Math.min(Math.round(crop.h), RH - y0));
  const out = new Uint8ClampedArray(w * zoom * h * zoom * 3);
  const ow = w * zoom;
  for (let y = 0; y < h * zoom; y++) {
    for (let x = 0; x < ow; x++) {
      const sx = x0 + ((x / zoom) | 0);
      const sy = y0 + ((y / zoom) | 0);
      const si = (sy * RW + sx) * 3;
      const di = (y * ow + x) * 3;
      out[di] = fb[si]; out[di + 1] = fb[si + 1]; out[di + 2] = fb[si + 2];
    }
  }
  return writePng(filePath, out, ow, h * zoom, fs);
}

/** Write an RGB framebuffer to a PNG file. */
export function writePng(filePath, fb, RW, RH, fs) {
  const raw = new Uint8Array((RW * 3 + 1) * RH);
  for (let y = 0; y < RH; y++) {
    raw[y * (RW * 3 + 1)] = 0;
    raw.set(fb.subarray(y * RW * 3, (y + 1) * RW * 3), y * (RW * 3 + 1) + 1);
  }
  const chunks = [];
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  chunks.push(sig);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, RW); dv.setUint32(4, RH);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(makeChunk('IHDR', ihdr));
  chunks.push(makeChunk('IDAT', zlibStore(raw)));
  chunks.push(makeChunk('IEND', new Uint8Array(0)));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { png.set(c, o); o += c.length; }
  fs.writeFileSync(filePath, png);
  return filePath;
}

function makeChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
