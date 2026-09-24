/**
 * levelcode.js — compact, URL-safe share codes for custom levels.
 *
 * A layout is 12 x 6 cells, each one character from LAYOUT_CHARS (13 symbols,
 * so 4 bits). Two cells pack into a byte, a checksum byte is appended, and the
 * 37 bytes become 50 base64url characters prefixed with a version tag:
 *
 *     g1.<base64url>        e.g.  index.html#level=g1.ABCD...
 *
 * Decoding validates the version, the length, every nibble and the checksum,
 * and returns null for anything malformed — a pasted link can never crash the
 * game or smuggle in characters the level builder does not understand.
 */
import { GRID } from '../config.js';
import { LAYOUT_CHARS } from './level.js';

const VERSION = 'g1';
const CELLS = GRID.cols * GRID.rows;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 1 >= bytes.length ? 2 : i + 2 >= bytes.length ? 3 : 4;
    for (let k = 0; k < chars; k++) out += B64[(n >> (18 - k * 6)) & 63];
  }
  return out;
}

function fromB64(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i += 4) {
    const chunk = str.slice(i, i + 4);
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const v = k < chunk.length ? B64.indexOf(chunk[k]) : 0;
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    bytes.push((n >> 16) & 255);
    if (chunk.length > 2) bytes.push((n >> 8) & 255);
    if (chunk.length > 3) bytes.push(n & 255);
  }
  return bytes;
}

function checksum(bytes) {
  let c = 0x5a;
  for (const b of bytes) c = ((c * 31) ^ b) & 255;
  return c;
}

/** Normalise any layout (array of row strings) to exactly rows x cols. */
export function normalizeLayout(rows) {
  const out = [];
  for (let r = 0; r < GRID.rows; r++) {
    let line = '';
    const src = rows?.[r] ?? '';
    for (let c = 0; c < GRID.cols; c++) {
      const ch = src[c] ?? '.';
      line += LAYOUT_CHARS.includes(ch) ? ch : '.';
    }
    out.push(line);
  }
  return out;
}

/** Layout -> share code. */
export function encodeLayout(rows) {
  const flat = normalizeLayout(rows).join('');
  const bytes = [];
  for (let i = 0; i < CELLS; i += 2) {
    bytes.push((LAYOUT_CHARS.indexOf(flat[i]) << 4) | LAYOUT_CHARS.indexOf(flat[i + 1] ?? '.'));
  }
  bytes.push(checksum(bytes));
  return `${VERSION}.${toB64(bytes)}`;
}

/** Share code -> layout (array of row strings), or null if invalid. */
export function decodeLayout(code) {
  if (typeof code !== 'string') return null;
  const m = /^g1\.([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) return null;
  const bytes = fromB64(m[1]);
  if (!bytes || bytes.length !== CELLS / 2 + 1) return null;
  const body = bytes.slice(0, -1);
  if (checksum(body) !== bytes[bytes.length - 1]) return null;
  let flat = '';
  for (const b of body) {
    const hi = b >> 4, lo = b & 15;
    if (hi >= LAYOUT_CHARS.length || lo >= LAYOUT_CHARS.length) return null;
    flat += LAYOUT_CHARS[hi] + LAYOUT_CHARS[lo];
  }
  const rows = [];
  for (let r = 0; r < GRID.rows; r++) rows.push(flat.slice(r * GRID.cols, (r + 1) * GRID.cols));
  return rows;
}

/**
 * Is this layout playable? Returns a list of human-readable problems (empty
 * list = fine). The editor shows these; the game refuses a layout with any.
 */
export function validateLayout(rows) {
  const flat = normalizeLayout(rows).join('');
  const problems = [];
  const bricks = [...flat].filter((c) => c !== '.').length;
  if (bricks === 0) problems.push('Place at least one brick.');
  const bosses = [...flat].filter((c) => c === 'B').length;
  if (bosses > 1) problems.push('Only one boss core per level.');
  const portals = [...flat].filter((c) => c === 'p').length;
  if (portals % 2) problems.push('Portals work in pairs — the odd one will become a plain brick.');
  return problems;
}

/** Read `#level=<code>` from a location hash. */
export function layoutFromHash(hash) {
  const m = /(?:^#|&)level=([^&]+)/.exec(hash ?? '');
  return m ? decodeLayout(decodeURIComponent(m[1])) : null;
}
