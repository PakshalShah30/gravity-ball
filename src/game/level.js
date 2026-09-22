/**
 * level.js — brick layouts, their destruction state and their rendering.
 *
 * Bricks live in a uniform grid (one cell per brick), which is what makes the
 * continuous collision detection in the world cheap: the swept ball maps to a
 * handful of candidate cells, no spatial hashing needed.
 *
 * Layouts 1-5 are hand-authored so the first minutes of the game teach the
 * mechanics in order (plain -> armoured -> bombs -> shields). From level 6 a
 * seeded generator takes over with mirrored patterns, so runs still differ.
 */
import { makeRng, clamp, mixHex, shade, easeOutBack, easeOutCubic, TAU } from '../core/math.js';
import { GRID, COLORS } from '../config.js';

export const KIND = { NORMAL: 0, ARMORED: 1, BOMB: 2, SHIELD: 3 };

/** '.' empty | 1-6 palette row | a armoured | b bomb | s shield */
const TEMPLATES = [
  [
    '....1111....',
    '...222222...',
    '..33333333..',
    '.4444444444.',
    '555555555555',
  ],
  [
    '....1111....',
    '...122221...',
    '..13333331..',
    '.144bb4441..',
    '155555555551',
  ],
  [
    '1111....1111',
    '2552....2552',
    '333333333333',
    '444b4444b444',
    '.5555555555.',
    '..aa....aa..',
  ],
  [
    '1ss1....1ss1',
    '2222b22b2222',
    '333333333333',
    '.4444444444.',
    '..55.aa.55..',
    '...b....b...',
  ],
  [
    'a1a1a1a1a1a1',
    '2b2b2b2b2b2b',
    '333333333333',
    'ss.ss.ss.ss.',
    '444444444444',
    '.5.5.5.5.5.5',
  ],
];

const PATTERNS = ['wave', 'checker', 'rings', 'columns', 'diamond'];

export class Level {
  constructor() {
    this.cols = GRID.cols;
    this.rows = GRID.rows;
    this.grid = new Array(this.cols * this.rows).fill(null);
    this.bricks = [];
    this.alive = 0;
    this.total = 0;
    this.index = 1;
    this.time = 0;
    this.palette = COLORS.brick;
    this.rng = makeRng(1);
    this.cleared = 0;     // 0..1 during the clear animation
    this.clearing = false;
  }

  // ----------------------------------------------------------------- build ---

  build(index, seed) {
    this.index = index;
    this.time = 0;
    this.bricks.length = 0;
    this.grid.fill(null);
    this.alive = 0;
    this.clearing = false;
    this.cleared = 0;
    this.rng = makeRng(seed + index * 7919);

    const rng = this.rng;
    const tpl = index <= TEMPLATES.length ? TEMPLATES[index - 1] : this._generate(index, rng);
    const maxHp = index >= 8 ? 2 : 1;

    for (let row = 0; row < tpl.length && row < this.rows; row++) {
      const line = tpl[row];
      for (let col = 0; col < this.cols; col++) {
        const ch = line[col] ?? '.';
        if (ch === '.' || ch === ' ') continue;
        let kind = KIND.NORMAL, hp = 1;
        if (ch === 'a') { kind = KIND.ARMORED; hp = index >= 10 ? 4 : 3; }
        else if (ch === 'b') { kind = KIND.BOMB; hp = 1; }
        else if (ch === 's') { kind = KIND.SHIELD; hp = 1; }
        else if (ch >= '1' && ch <= '9') {
          kind = KIND.NORMAL;
          // Later levels harden a share of the plain bricks.
          hp = rng() < clamp(0.08 * (index - maxHp * 3), 0, 0.5) ? 2 : 1;
        }
        const x = GRID.originX + col * GRID.pitchX;
        const y = GRID.originY + row * GRID.pitchY;
        const colorIdx = (ch >= '1' && ch <= '9') ? (parseInt(ch, 10) - 1) % this.palette.length : (row * 2) % this.palette.length;
        const brick = {
          col, row, x, y,
          w: GRID.bw, h: GRID.bh,
          kind, hp, maxHp: hp,
          alive: true,
          flash: 0, spawn: -1, spawnDelay: 0,
          wob: 0, seed: rng() * TAU,
          color: this.palette[colorIdx],
        };
        // Assemble animation: a wave from the middle of the row outward.
        brick.spawnDelay = Math.abs(col - (this.cols - 1) / 2) * 0.045 + row * 0.02;
        this.bricks.push(brick);
        this.grid[col + row * this.cols] = brick;
        this.alive++;
      }
    }
    this.total = this.alive;
    // Bricks only start assembling when the world tells them to.
    for (const b of this.bricks) b.spawn = -1;

    return this;
  }

  startIntro() {
    for (const b of this.bricks) b.spawn = 0;
  }

  /** Procedural layouts from level 6 on, mirrored for symmetry. */
  _generate(index, rng) {
    const rows = this.rows, cols = this.cols;
    const pattern = PATTERNS[(index - 6) % PATTERNS.length];
    const density = clamp(0.42 + (index - 6) * 0.035, 0.42, 0.86);
    const lines = [];
    for (let row = 0; row < rows; row++) {
      let line = '';
      for (let col = 0; col < cols; col++) {
        const m = col < cols / 2 ? col : cols - 1 - col;   // mirror axis
        let on = false;
        switch (pattern) {
          case 'wave': on = rng() < density && ((row + m) % 3 !== 2 || rng() < 0.4); break;
          case 'checker': on = ((row + m) % 2 === 0) ? rng() < density + 0.15 : rng() < density - 0.2; break;
          case 'rings': on = m < 1 || (row > 0 && row < rows - 1 && m > 2) || rng() < density * 0.4; break;
          case 'columns': on = m % 3 !== 1 ? rng() < density : rng() < density * 0.25; break;
          default: on = (m >= row - 1 && m <= (rows - 1) - row + 2) ? rng() < density + 0.2 : rng() < density * 0.25;
        }
        // Leave a small opening so the ball can reach the top of the field.
        line += on ? String(((row + m) % 5) + 1) : '.';
      }
      lines.push(line);
    }
    // Holes: guarantee at least two gaps per row.
    for (let row = 0; row < rows; row++) {
      let line = lines[row];
      for (let i = 0; i < 3; i++) {
        const col = (rng() * cols) | 0;
        line = line.slice(0, col) + '.' + line.slice(col + 1);
      }
      lines[row] = line;
    }
    // Special bricks sprinkled in.
    const special = (ch, count, minRow = 0) => {
      for (let i = 0; i < count; i++) {
        let row, col, guard = 40;
        do { row = minRow + ((rng() * (rows - minRow)) | 0); col = (rng() * cols) | 0; } while (lines[row][col] === ch && guard-- > 0);
        lines[row] = lines[row].slice(0, col) + ch + lines[row].slice(col + 1);
      }
    };
    special('b', Math.min(6, 1 + ((index - 6) / 3) | 0), 1);
    special('s', Math.min(8, 1 + ((index - 6) / 4) | 0), 1);
    special('a', Math.min(14, 2 + ((index - 6) / 2) | 0));
    return lines;
  }

  // ----------------------------------------------------------------- update ---

  update(dt, gravityDir) {
    this.time += dt;
    let spawning = false;
    for (const b of this.bricks) {
      if (!b.alive) continue;
      if (b.spawn >= 0) {
        b.spawn += dt;
        if (b.spawn < b.spawnDelay + 0.6) spawning = true;
      }
      if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 5.5);
      if (b.wob > 0) b.wob = Math.max(0, b.wob - dt * 4);
    }
    if (this.clearing) this.cleared = Math.min(1, this.cleared + dt / 0.5);
    return spawning;
  }

  get introDone() {
    for (const b of this.bricks) {
      if (b.alive && b.spawn >= 0 && b.spawn < b.spawnDelay + 0.6) return false;
    }
    return true;
  }

  /** Damage a brick. Returns 'destroyed' | 'damaged' | 'blocked'. */
  hit(brick, damage, world) {
    if (!brick.alive) return 'blocked';
    if (brick.kind === KIND.SHIELD && !(world.flip.active || damage > 1)) {
      brick.flash = 1;
      brick.wob = 1;
      return 'blocked';
    }
    brick.hp -= damage;
    brick.flash = 1;
    brick.wob = 1;
    if (brick.hp > 0) return 'damaged';
    this.kill(brick, world);
    return 'destroyed';
  }

  kill(brick, world) {
    if (!brick.alive) return;
    brick.alive = false;
    this.alive--;
    this.grid[brick.col + brick.row * this.cols] = null;
  }

  /** Bricks inside an AABB (used by bomb explosions). */
  forEachInBox(x0, y0, x1, y1, cb) {
    const c0 = clamp(Math.floor((x0 - GRID.originX) / GRID.pitchX), 0, this.cols - 1);
    const c1 = clamp(Math.ceil((x1 - GRID.originX) / GRID.pitchX), 0, this.cols - 1);
    const r0 = clamp(Math.floor((y0 - GRID.originY) / GRID.pitchY), 0, this.rows - 1);
    const r1 = clamp(Math.ceil((y1 - GRID.originY) / GRID.pitchY), 0, this.rows - 1);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const b = this.grid[col + row * this.cols];
        if (b && b.alive) cb(b);
      }
    }
  }

  /**
   * Collect every brick alive in the swept AABB, ordered by cell distance from
   * the ball so the closest is tested first.
   */
  collectSwept(x0, y0, x1, y1, out) {
    out.length = 0;
    const c0 = clamp(Math.floor((x0 - GRID.originX) / GRID.pitchX), 0, this.cols - 1);
    const c1 = clamp(Math.ceil((x1 - GRID.originX) / GRID.pitchX), 0, this.cols - 1);
    const r0 = clamp(Math.floor((y0 - GRID.originY) / GRID.pitchY), 0, this.rows - 1);
    const r1 = clamp(Math.ceil((y1 - GRID.originY) / GRID.pitchY), 0, this.rows - 1);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const b = this.grid[col + row * this.cols];
        if (b && b.alive) out.push(b);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ draw ---

  draw(r, ctxRun) {
    const t = this.time;
    for (const b of this.bricks) {
      if (!b.alive) continue;
      drawBrick(r, b, t, this.index, ctxRun);
    }
  }

  /** Total brick count still alive — HUD + game-over stats love this. */
  get remaining() { return this.alive; }
}

function drawBrick(r, b, t, level, run) {
  const spawned = b.spawn < 0 ? 1 : clamp((b.spawn - b.spawnDelay) / 0.6, 0, 1);
  if (spawned <= 0) return;

  const wob = b.wob * 0.5;
  const shakeX = wob * Math.sin(t * 60 + b.seed) * 3;
  const shakeY = wob * Math.cos(t * 52 + b.seed) * 2;

  let x = b.x + shakeX, y = b.y + shakeY, w = b.w, h = b.h, scale = 1;
  if (spawned < 1) {
    // assemble: fly in from the middle of the field, overshoot, settle
    const e = easeOutBack(spawned);
    const cx = GRID.originX + GRID.cols * GRID.pitchX / 2;
    x = cx + (b.x - cx) * e;
    scale = 0.4 + 0.6 * easeOutCubic(Math.min(1, spawned * 1.6));
    y = b.y - (1 - spawned) * 30;
  }

  const cx = x + w / 2, cy = y + h / 2;
  const halfW = w / 2 * scale, halfH = h / 2 * scale;
  x = cx - halfW; y = cy - halfH; w = halfW * 2; h = halfH * 2;

  const damaged = b.hp < b.maxHp;
  let color = b.color;
  if (b.kind === KIND.ARMORED) color = mixHex(b.color, COLORS.armored, 0.55);
  if (b.kind === KIND.BOMB) color = COLORS.bomb;
  if (b.kind === KIND.SHIELD) color = mixHex(b.color, COLORS.shield, 0.6);
  if (b.kind === KIND.NORMAL && b.hp > 1) color = mixHex(color, '#ffffff', 0.25);
  if (damaged) color = mixHex(color, '#101820', 0.42);
  if (b.flash > 0) color = mixHex(color, '#ffffff', b.flash * 0.85);

  // --- glow (additive, behind the brick). Kept deliberately subtle: 12 bricks
  // in a row each add their own halo, so anything stronger blows out to white.
  const glowAmt = 0.045 + b.flash * 0.42 + (b.kind === KIND.BOMB
    ? 0.1 + 0.07 * Math.sin(t * 6 + b.seed)
    : b.kind === KIND.SHIELD ? 0.06 + 0.03 * Math.sin(t * 3 + b.seed) : 0);
  // `spread` is 0 for idle bricks on purpose: an outset halo would accumulate
  // across the 6 px gaps between neighbours and merge each row into a solid
  // bar. The glow stays inside the brick, and only the transient hit flash
  // bleeds outward.
  const glowSpread = b.flash > 0.05 ? 3 + b.flash * 6 : 0;
  r.glowRect(x, y, w, h, color, glowAmt, glowSpread);

  // --- body: flat fill + bevel, no per-brick gradients (keeps the frame flat)
  r.rect(x, y, w, h, { fill: shade(color, 0.34), radius: 4 });
  const band = b.kind === KIND.SHIELD ? 0.34 : 0.7;
  r.rect(x + 1, y + 1, w - 2, h * band, { fill: color, radius: 3 });
  if (b.kind === KIND.NORMAL && !damaged) {
    r.rect(x + 2, y + 2, w - 4, 2, { fill: mixHex(color, '#ffffff', 0.55), alpha: 0.7, radius: 1 });
  }
  r.rect(x, y, w, h, { stroke: mixHex(color, '#000000', 0.35), lw: 1, radius: 4 });

  // --- kind-specific detailing
  if (b.kind === KIND.ARMORED) {
    const studs = b.maxHp;
    for (let i = 0; i < studs; i++) {
      const sx = x + 6 + i * ((w - 12) / Math.max(1, studs - 1));
      r.circle(sx, cy, 2.1, { fill: mixHex(color, '#ffffff', 0.5), alpha: 0.9 });
      if (damaged && i >= b.hp) r.circle(sx, cy, 2.6, { stroke: COLORS.danger, lw: 1.2, alpha: 0.9 });
    }
    r.rect(x + 2.5, y + 2.5, w - 5, h - 5, { stroke: mixHex(color, '#ffffff', 0.3), lw: 1, alpha: 0.55, radius: 3 });
  } else if (b.kind === KIND.BOMB) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 7 + b.seed);
    r.circle(cx, cy, 4.6 + pulse * 1.2, { fill: mixHex(COLORS.bombCore, '#ffffff', pulse * 0.6) });
    for (let i = 0; i < 8; i++) {
      const a = t * 1.6 + i * TAU / 8;
      r.line(cx + Math.cos(a) * 7, cy + Math.sin(a) * 4.5, cx + Math.cos(a) * 10, cy + Math.sin(a) * 6.5,
        { color: COLORS.bombCore, lw: 1.6, alpha: 0.5 + pulse * 0.4 });
    }
  } else if (b.kind === KIND.SHIELD) {
    // animated shimmer sweep across the shield
    const sweep = ((t * 0.6 + b.seed * 0.1) % 1) * (w + 40) - 20;
    r.rect(x + 1, y + 1, w - 2, h - 2, { fill: 'rgba(255,255,255,0.12)' });
    r.poly([[x + sweep, y + h], [x + sweep + 10, y], [x + sweep + 18, y], [x + sweep + 8, y + h]],
      { fill: 'rgba(255,255,255,0.30)' });
    r.rect(x + 1.5, y + 1.5, w - 3, h - 3, { stroke: mixHex(COLORS.shield, '#ffffff', 0.4), lw: 1, alpha: 0.8, radius: 3 });
  }

  // --- cracks when damaged
  if (damaged) {
    const dark = 'rgba(6,10,16,0.72)';
    r.line(x + w * 0.18, y + h * 0.2, x + w * 0.42, y + h * 0.85, { color: dark, lw: 1.4 });
    r.line(x + w * 0.42, y + h * 0.85, x + w * 0.6, y + h * 0.4, { color: dark, lw: 1.2 });
    r.line(x + w * 0.72, y + h * 0.1, x + w * 0.62, y + h * 0.6, { color: dark, lw: 1.1 });
    if (b.hp <= 1 && b.maxHp > 1) {
      r.rect(x - 1, y - 1, w + 2, h + 2, { stroke: 'rgba(255,90,90,0.35)', lw: 1, radius: 4 });
    }
  }
}
