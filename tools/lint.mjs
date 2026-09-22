/**
 * lint.mjs — dependency-free syntax check for every ES module in the project.
 *
 * `node --check` only accepts modules with the .mjs extension, so each file is
 * copied to a temp name first. Run via `npm run lint` or `npm test`.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-lint-'));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = [...walk('src'), ...walk('tools'), ...walk('test')];
let failed = 0;
for (const f of files) {
  const target = path.join(tmp, f.replace(/[\\/]/g, '_') + '.check.mjs');
  fs.copyFileSync(f, target);
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`✗ ${f}\n${(e.stderr ?? '').toString().split('\n').slice(0, 8).join('\n')}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} file(s) failed to parse` : `✓ ${files.length} modules parsed cleanly`);
process.exit(failed ? 1 : 0);
