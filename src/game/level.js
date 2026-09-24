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
import { makeRng, clamp, mixHex, rgba, shade, easeOutBack, easeOutCubic, TAU } from '../core/math.js';
import { GRID, COLORS } from '../config.js';

export const KIND = { NORMAL: 0, ARMORED: 1, BOMB: 2, SHIELD: 3, PORTAL: 4, GHOST: 5, BOSS: 6 };

/**
 * '.' empty | 1-6 palette row | a armoured | b bomb | s shield
 * p portal (paired in reading order: the ball enters one and leaves the other)
 * g ghost  (phases in and out: solid for a while, then the ball passes through)
 */
/** Every character a layout may contain (the level editor's palette). */
export const LAYOUT_CHARS = '.123456abspgB';

/** Boss levels: every 5th level from 10 on hosts a core that spans 4x2 cells. */
export function isBossLevel(index) { return index >= 10 && index % 5 === 0; }

export const GHOST = { solid: 1.6, phased: 1.1 };   // seconds per phase
export const BOSS = { cols: 4, rows: 2, baseHp: 22, hpPerLevel: 2, guardEvery: 7, guardTime: 2.2 };
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

  /**
   * Build a level. `opts.layout` (an array of row strings) replaces the
   * authored/procedural layout — used by the level editor and custom codes.
   * `opts.procedural` skips the hand-built teaching levels (daily challenge).
   */
  build(index, seed, opts = {}) {
    this.index = index;
    this.boss = null;
    this.portals = [];
    this.time = 0;
    this.bricks.length = 0;
    this.grid.fill(null);
    this.alive = 0;
    this.bossDown = false;
    this.clearing = false;
    this.cleared = 0;
    this.rng = makeRng(seed + index * 7919);

    const rng = this.rng;
    const tpl = opts.layout
      ? opts.layout
      : (index <= TEMPLATES.length && !opts.procedural)
        ? TEMPLATES[index - 1]
        : this._generate(opts.procedural ? index + TEMPLATES.length : index, rng, isBossLevel(index) && !opts.procedural);
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
        else if (ch === 'p') { kind = KIND.PORTAL; hp = 3; }
        else if (ch === 'g') { kind = KIND.GHOST; hp = 1; }
        else if (ch === 'B') continue;   // boss footprint, placed below
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
        if (kind === KIND.GHOST) brick.phaseT = (col + row) % 2 ? GHOST.solid * 0.5 : 0;
        this.bricks.push(brick);
        this.grid[col + row * this.cols] = brick;
        if (kind === KIND.PORTAL) this.portals.push(brick);
        this.alive++;
      }
    }
    this._pairPortals();
    const bossAt = tpl.findIndex((line) => line.includes('B'));
    if (bossAt >= 0) this._placeBoss(tpl[bossAt].indexOf('B'), bossAt, index);
    this.total = this.alive;
    // Bricks only start assembling when the world tells them to.
    for (const b of this.bricks) b.spawn = -1;

    return this;
  }

  /** Portals pair up in reading order; an unpaired one becomes a plain brick. */
  _pairPortals() {
    const ps = this.portals;
    for (let i = 0; i + 1 < ps.length; i += 2) {
      ps[i].partner = ps[i + 1];
      ps[i + 1].partner = ps[i];
      ps[i].pair = ps[i + 1].pair = i / 2;
    }
    if (ps.length % 2) {
      const lone = ps.pop();
      lone.kind = KIND.NORMAL;
      lone.hp = lone.maxHp = 1;
    }
  }

  /** The boss core: one brick object that owns a block of grid cells. */
  _placeBoss(col, row, index) {
    col = clamp(col, 0, this.cols - BOSS.cols);
    row = clamp(row, 0, this.rows - BOSS.rows);
    // Clear whatever the layout put under the footprint.
    for (let r = row; r < row + BOSS.rows; r++) {
      for (let c = col; c < col + BOSS.cols; c++) {
        const b = this.grid[c + r * this.cols];
        if (b) { b.alive = false; this.alive--; this.grid[c + r * this.cols] = null; }
      }
    }
    const hp = BOSS.baseHp + index * BOSS.hpPerLevel;
    const boss = {
      col, row, cells: [],
      x: GRID.originX + col * GRID.pitchX,
      y: GRID.originY + row * GRID.pitchY,
      w: BOSS.cols * GRID.pitchX - GRID.gapX,
      h: BOSS.rows * GRID.pitchY - GRID.gapY,
      kind: KIND.BOSS, hp, maxHp: hp, alive: true,
      flash: 0, spawn: -1, spawnDelay: 0.3, wob: 0, seed: 1.7,
      color: COLORS.boss ?? '#ff3fa4',
      guard: 0, guardClock: BOSS.guardEvery,
    };
    for (let r = row; r < row + BOSS.rows; r++) {
      for (let c = col; c < col + BOSS.cols; c++) {
        this.grid[c + r * this.cols] = boss;
        boss.cells.push(c + r * this.cols);
      }
    }
    this.bricks.push(boss);
    this.boss = boss;
    this.alive++;
  }

  /** True if the ball should collide with this brick right now. */
  isSolid(b) {
    return b.kind !== KIND.GHOST || !b.phased;
  }

  startIntro() {
    for (const b of this.bricks) b.spawn = 0;
  }

  /** Procedural layouts from level 6 on, mirrored for symmetry. */
  _generate(index, rng, withBoss = false) {
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
    // Newer mechanics arrive gradually: ghosts from 7, portal pairs from 8.
    if (index >= 7) special('g', Math.min(6, 1 + ((index - 7) / 3) | 0), 2);
    if (index >= 8) special('p', 2 * Math.min(2, 1 + ((index - 8) / 6) | 0), 2);
    if (withBoss) {
      const r0 = 1, c0 = 4;
      lines[r0] = lines[r0].slice(0, c0) + 'B' + lines[r0].slice(c0 + 1);
    }
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
      if (b.kind === KIND.GHOST) {
        b.phaseT = (b.phaseT ?? 0) + dt;
        const cycle = GHOST.solid + GHOST.phased;
        b.phased = (b.phaseT % cycle) > GHOST.solid;
      } else if (b.kind === KIND.BOSS && b.spawn >= 0) {
        if (b.guard > 0) b.guard = Math.max(0, b.guard - dt);
        else {
          b.guardClock -= dt;
          if (b.guardClock <= 0) { b.guard = BOSS.guardTime; b.guardClock = BOSS.guardEvery; }
        }
      }
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
    const guarded = brick.kind === KIND.BOSS && brick.guard > 0;
    if ((brick.kind === KIND.SHIELD || guarded) && !(world.flip.active || damage > 1)) {
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
    if (brick.cells) for (const c of brick.cells) this.grid[c] = null;
    else this.grid[brick.col + brick.row * this.cols] = null;
    if (brick === this.boss) this.bossDown = true;
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
        if (b && b.alive && (b.kind !== KIND.BOSS || (col === Math.max(c0, b.col) && row === Math.max(r0, b.row)))) cb(b);
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
        if (b && b.alive && this.isSolid(b) && !out.includes(b)) out.push(b);
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
  if (b.kind === KIND.PORTAL) color = COLORS.portal[(b.pair ?? 0) % COLORS.portal.length];
  if (b.kind === KIND.GHOST) color = COLORS.ghost;
  if (b.kind === KIND.BOSS) color = b.guard > 0 ? mixHex(COLORS.boss, COLORS.shield, 0.6) : COLORS.boss;
  // Ghosts fade out while phased so the player can read "the ball passes now".
  const ghostAlpha = b.kind === KIND.GHOST ? (b.phased ? 0.22 : 1) : 1;
  if (ghostAlpha < 1) r.ctx.globalAlpha = ghostAlpha;
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
  } else if (b.kind === KIND.PORTAL) {
    // swirl: two counter-rotating arcs + a dark eye
    r.circle(cx, cy, h * 0.34, { fill: '#05060d', alpha: 0.85 });
    for (let i = 0; i < 3; i++) {
      const a = t * (i % 2 ? -4 : 5) + i * 2.1 + b.seed;
      r.line(cx + Math.cos(a) * h * 0.2, cy + Math.sin(a) * h * 0.2,
        cx + Math.cos(a + 1.2) * h * 0.42, cy + Math.sin(a + 1.2) * h * 0.42,
        { color: mixHex(color, '#ffffff', 0.5), lw: 1.6, alpha: 0.9 });
    }
  } else if (b.kind === KIND.GHOST) {
    const s = 0.5 + 0.5 * Math.sin(t * 5 + b.seed);
    r.rect(x + 3, y + 3, w - 6, h - 6, { stroke: mixHex(color, '#ffffff', 0.5), lw: 1, alpha: 0.4 + s * 0.4, radius: 3 });
    r.circle(cx - 7, cy - 1, 2.2, { fill: '#05060d', alpha: 0.8 });
    r.circle(cx + 7, cy - 1, 2.2, { fill: '#05060d', alpha: 0.8 });
  } else if (b.kind === KIND.BOSS) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    const k = b.hp / b.maxHp;
    r.circle(cx, cy, h * 0.3 + pulse * 3, { fill: mixHex(COLORS.bombCore, '#ffffff', pulse * 0.5) });
    r.circle(cx, cy, h * 0.42, { stroke: mixHex(color, '#ffffff', 0.4), lw: 2, alpha: 0.8 });
    // health strip inside the core
    r.rect(x + 8, y + h - 9, (w - 16), 4, { fill: 'rgba(0,0,0,0.5)', radius: 2 });
    r.rect(x + 8, y + h - 9, (w - 16) * k, 4, { fill: mixHex(COLORS.danger, COLORS.gold, k), radius: 2 });
    if (b.guard > 0) {
      r.rect(x - 4, y - 4, w + 8, h + 8, { stroke: rgba(COLORS.shield, 0.5 + pulse * 0.4), lw: 2.5, radius: 8 });
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
  if (ghostAlpha < 1) r.ctx.globalAlpha = 1;
}
