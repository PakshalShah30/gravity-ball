/**
 * editor.js — paint a 12x6 layout, validate it, and hand it to the game as a
 * share link (index.html#level=<code>). Uses the same codec and colours as the
 * game, so what you paint is exactly what gets built.
 */
import { GRID, COLORS } from '../config.js';
import { LAYOUT_CHARS } from '../game/level.js';
import { encodeLayout, decodeLayout, validateLayout, normalizeLayout } from '../game/levelcode.js';
import { makeRng } from '../core/math.js';

const TOOLS = [
  { ch: '1', name: 'Cyan', color: COLORS.brick[0] },
  { ch: '2', name: 'Blue', color: COLORS.brick[1] },
  { ch: '3', name: 'Violet', color: COLORS.brick[2] },
  { ch: '4', name: 'Pink', color: COLORS.brick[3] },
  { ch: '5', name: 'Orange', color: COLORS.brick[4] },
  { ch: '6', name: 'Gold', color: COLORS.brick[5] },
  { ch: 'a', name: 'Armoured', color: COLORS.armored, label: 'A' },
  { ch: 'b', name: 'Bomb', color: COLORS.bomb, label: 'B' },
  { ch: 's', name: 'Shield', color: COLORS.shield, label: 'S' },
  { ch: 'p', name: 'Portal', color: COLORS.portal[0], label: 'P' },
  { ch: 'g', name: 'Ghost', color: COLORS.ghost, label: 'G' },
  { ch: 'B', name: 'Boss core', color: COLORS.boss, label: '★' },
  { ch: '.', name: 'Eraser', color: 'transparent', label: '×' },
];
const byCh = Object.fromEntries(TOOLS.map((t) => [t.ch, t]));

const $ = (id) => document.getElementById(id);
const board = $('board');
let grid = normalizeLayout([]).map((r) => [...r]);
let tool = '1';
let painting = null;   // the char being painted during a drag

// ------------------------------------------------------------------ build ---
const cells = [];
for (let r = 0; r < GRID.rows; r++) {
  for (let c = 0; c < GRID.cols; c++) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cell';
    el.dataset.r = r; el.dataset.c = c;
    el.setAttribute('role', 'gridcell');
    board.appendChild(el);
    cells.push(el);
  }
}

const pal = $('palette');
for (const t of TOOLS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.dataset.ch = t.ch;
  b.innerHTML = `<i class="sw" style="background:${t.color}"></i>${t.name}`;
  pal.appendChild(b);
}
pal.addEventListener('click', (e) => {
  const ch = e.target.closest('[data-ch]')?.dataset.ch;
  if (ch) { tool = ch; renderPalette(); }
});

function renderPalette() {
  for (const b of pal.children) b.setAttribute('aria-checked', String(b.dataset.ch === tool));
}

// ------------------------------------------------------------------ paint ---
function set(r, c, ch) {
  if (ch === 'B') {
    // Only one boss: painting a new one moves it.
    for (const row of grid) for (let i = 0; i < row.length; i++) if (row[i] === 'B') row[i] = '.';
  }
  grid[r][c] = ch;
  render();
}

function cellFrom(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.cell');
  return el && board.contains(el) ? el : null;
}

board.addEventListener('pointerdown', (e) => {
  const el = cellFrom(e);
  if (!el) return;
  e.preventDefault();
  painting = e.button === 2 ? '.' : tool;
  set(+el.dataset.r, +el.dataset.c, painting);
  board.setPointerCapture?.(e.pointerId);
});
board.addEventListener('pointermove', (e) => {
  if (painting === null || painting === 'B') return;
  const el = cellFrom(e);
  if (el && grid[+el.dataset.r][+el.dataset.c] !== painting) set(+el.dataset.r, +el.dataset.c, painting);
});
addEventListener('pointerup', () => { painting = null; });
board.addEventListener('contextmenu', (e) => e.preventDefault());
// Keyboard: Enter/Space on a focused cell paints it with the current tool.
board.addEventListener('keydown', (e) => {
  const el = e.target.closest('.cell');
  if (!el) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); set(+el.dataset.r, +el.dataset.c, tool); }
  const moves = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
  if (moves[e.key]) {
    e.preventDefault();
    const r = Math.max(0, Math.min(GRID.rows - 1, +el.dataset.r + moves[e.key][0]));
    const c = Math.max(0, Math.min(GRID.cols - 1, +el.dataset.c + moves[e.key][1]));
    cells[r * GRID.cols + c].focus();
  }
});
// Number keys pick a palette entry quickly.
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const t = TOOLS.find((x) => x.ch === e.key && e.key !== '.');
  if (t) { tool = t.ch; renderPalette(); }
  if (e.key === 'Backspace' || e.key === 'Delete') { tool = '.'; renderPalette(); }
});

// ----------------------------------------------------------------- render ---
function layout() { return grid.map((r) => r.join('')); }

function render() {
  // Boss footprint (4x2 from the anchor, clamped like the game does).
  const shadow = new Set();
  grid.forEach((row, r) => row.forEach((ch, c) => {
    if (ch !== 'B') return;
    const c0 = Math.min(c, GRID.cols - 4), r0 = Math.min(r, GRID.rows - 2);
    for (let y = r0; y < r0 + 2; y++) for (let x = c0; x < c0 + 4; x++) shadow.add(y * GRID.cols + x);
  }));
  let n = 0;
  cells.forEach((el, i) => {
    const ch = grid[Math.floor(i / GRID.cols)][i % GRID.cols];
    const t = byCh[ch];
    const filled = ch !== '.';
    if (filled) n++;
    el.classList.toggle('filled', filled);
    el.classList.toggle('boss-shadow', !filled && shadow.has(i));
    el.style.background = filled ? t.color : '';
    el.textContent = filled ? (t.label ?? '') : '';
    el.setAttribute('aria-label', `row ${Math.floor(i / GRID.cols) + 1}, column ${(i % GRID.cols) + 1}: ${filled ? t.name : 'empty'}`);
  });
  $('count').textContent = `${n} brick${n === 1 ? '' : 's'}`;
  const code = encodeLayout(layout());
  if (document.activeElement !== $('code')) $('code').value = code;
  const problems = validateLayout(layout());
  $('problems').innerHTML = problems.map((p) => `<li class="${/pairs/.test(p) ? '' : 'err'}">${p}</li>`).join('');
  const blocking = problems.filter((p) => !/pairs/.test(p));
  $('play').disabled = blocking.length > 0;
  $('copy').disabled = blocking.length > 0;
  history.replaceState(null, '', `#level=${code}`);
}

function status(msg) { $('status').textContent = msg; }

function shareUrl() {
  const url = new URL('index.html', location.href);
  url.hash = `level=${encodeLayout(layout())}`;
  return url.href;
}

// ---------------------------------------------------------------- actions ---
$('play').addEventListener('click', () => { location.href = shareUrl(); });
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shareUrl()); status('Link copied — send it to anyone.'); }
  catch { $('code').select(); status('Copy the code above (clipboard blocked).'); }
});
$('clear').addEventListener('click', () => { grid = normalizeLayout([]).map((r) => [...r]); render(); status('Cleared.'); });
$('mirror').addEventListener('click', () => {
  grid = grid.map((row) => row.map((ch, c) => (c < GRID.cols / 2 ? ch : row[GRID.cols - 1 - c] === 'B' ? '.' : row[GRID.cols - 1 - c])));
  render(); status('Mirrored the left half onto the right.');
});
$('random').addEventListener('click', () => {
  const rng = makeRng((Math.random() * 1e9) | 0);
  const pick = '1234566....abspg';
  grid = grid.map((row, r) => row.map(() => {
    return (rng() < 0.62 || r < 2) ? pick[(rng() * pick.length) | 0] : '.';
  }));
  // mirror for symmetry, like the game's generator
  grid = grid.map((row) => row.map((ch, c) => (c < GRID.cols / 2 ? ch : row[GRID.cols - 1 - c])));
  render(); status('Random symmetric layout.');
});
$('load').addEventListener('click', () => {
  const rows = decodeLayout($('code').value);
  if (!rows) return status('That code is not valid.');
  grid = rows.map((r) => [...r]); render(); status('Loaded.');
});

// ------------------------------------------------------------------ start ---
const fromHash = /level=([^&]+)/.exec(location.hash);
const initial = fromHash ? decodeLayout(decodeURIComponent(fromHash[1])) : null;
if (initial) grid = initial.map((r) => [...r]);
else grid = normalizeLayout(['....1111....', '...2b22b2...', '..33333333..', '.p4444g444p.', 'aa55555555aa', '']).map((r) => [...r]);
renderPalette();
render();
console.assert(LAYOUT_CHARS.length <= 16, 'layout alphabet must fit in 4 bits');
