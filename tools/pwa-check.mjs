/**
 * pwa-check.mjs — keeps the offline build honest: every file the game can
 * load must be in the service worker's precache list, every listed file must
 * exist, and the manifest must parse and point at real icons.
 */
import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
const fail = (m) => { failures++; console.log(`  ✗ ${m}`); };

const sw = fs.readFileSync('sw.js', 'utf8');
const list = [...sw.matchAll(/^\s*'([^']+)',?$/gm)].map((m) => m[1]).filter((f) => f !== './');

for (const f of list) if (!fs.existsSync(f)) fail(`sw.js lists a missing file: ${f}`);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p.split(path.sep).join('/'));
  }
  return out;
}
for (const f of [...walk('src'), 'index.html', 'editor.html']) {
  if (!list.includes(f)) fail(`sw.js does not precache ${f}`);
}

let manifest;
try { manifest = JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8')); } catch (e) { fail(`manifest does not parse: ${e.message}`); }
if (manifest) {
  for (const i of manifest.icons ?? []) if (!fs.existsSync(i.src)) fail(`manifest icon missing: ${i.src}`);
  if (!manifest.start_url) fail('manifest has no start_url');
}
for (const page of ['index.html', 'editor.html']) {
  if (!fs.readFileSync(page, 'utf8').includes('manifest.webmanifest')) fail(`${page} does not link the manifest`);
}

console.log(failures ? `\n${failures} PWA problem(s)` : `✓ PWA: ${list.length} precached files, manifest OK`);
process.exit(failures ? 1 : 0);
