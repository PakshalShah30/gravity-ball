/**
 * panels.js — the few bits of UI that are better as HTML than canvas: the
 * title-screen button bar (touch players have no keyboard for C / H / E) and
 * the Records dialog (high scores, achievements, lifetime stats, skins).
 *
 * Everything is built lazily and guarded, so the headless test harness — which
 * has no real DOM — simply skips it.
 */
import { ACHIEVEMENTS, SKINS, dayKey } from './progress.js';

const CSS = `
#gb-bar{position:fixed;right:calc(12px + env(safe-area-inset-right));top:calc(12px + env(safe-area-inset-top));display:none;gap:6px;z-index:5}
body[data-state="menu"] #gb-bar{display:flex}
#gb-bar button,#gb-rec button{font:800 12px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#e8f4ff;background:rgba(10,16,32,.85);border:1px solid rgba(56,245,255,.45);border-radius:999px;padding:9px 14px;cursor:pointer}
#gb-bar button:hover,#gb-rec button:hover{background:rgba(56,245,255,.18)}
#gb-bar button:focus-visible,#gb-rec button:focus-visible{outline:2px solid #38f5ff;outline-offset:2px}
#gb-rec{position:fixed;inset:0;display:none;place-items:center;background:rgba(4,5,10,.78);z-index:10;cursor:auto}
#gb-rec.open{display:grid}
#gb-rec .card{width:min(760px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;background:#0b1122;border:1px solid rgba(56,245,255,.35);border-radius:16px;padding:20px 22px;color:#e8f4ff;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;box-shadow:0 0 60px rgba(56,245,255,.12)}
#gb-rec h2{margin:0 0 4px;font-size:22px;letter-spacing:.12em}
#gb-rec h3{margin:18px 0 8px;font-size:12px;letter-spacing:.2em;color:#38f5ff}
#gb-rec table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
#gb-rec td,#gb-rec th{padding:5px 6px;border-bottom:1px solid rgba(255,255,255,.07);text-align:left}
#gb-rec th{color:#7d8ba6;font-size:11px;letter-spacing:.14em}
#gb-rec .ach{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
#gb-rec .ach div{padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}
#gb-rec .ach .on{border-color:rgba(255,200,67,.6);background:rgba(255,200,67,.08)}
#gb-rec .ach b{display:block;font-size:13px}
#gb-rec .ach span{font-size:12px;color:#9aa8c2}
#gb-rec .skins{display:flex;flex-wrap:wrap;gap:8px}
#gb-rec .skins button{display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:.04em}
#gb-rec .skins button[aria-pressed="true"]{border-color:#ffc843;background:rgba(255,200,67,.14)}
#gb-rec .skins button:disabled{opacity:.4;cursor:not-allowed}
#gb-rec .sw{width:28px;height:8px;border-radius:4px;display:inline-block}
#gb-rec .stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
#gb-rec .stats div{background:rgba(255,255,255,.04);border-radius:10px;padding:8px 10px}
#gb-rec .stats b{display:block;font-size:18px}
#gb-rec .stats span{font-size:11px;color:#7d8ba6;letter-spacing:.12em;text-transform:uppercase}
#gb-rec .top{display:flex;justify-content:space-between;align-items:center;gap:12px}
#gb-rec .muted{color:#7d8ba6}
`;

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export class Panels {
  constructor({ progress, onDaily, onEditor, onSkin, onClose }) {
    this.progress = progress;
    this.onDaily = onDaily;
    this.onEditor = onEditor;
    this.onSkin = onSkin;
    this.onClose = onClose;
    const doc = globalThis.document;
    this.ok = !!(doc?.body?.insertAdjacentHTML && doc.querySelector);
    if (!this.ok) return;

    const style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.appendChild(style);

    doc.body.insertAdjacentHTML('beforeend', `
      <nav id="gb-bar" aria-label="Game modes">
        <button type="button" data-act="daily">Daily</button>
        <button type="button" data-act="records">Records</button>
        <button type="button" data-act="editor">Editor</button>
      </nav>
      <div id="gb-rec" role="dialog" aria-modal="true" aria-labelledby="gb-rec-title"><div class="card"></div></div>`);
    this.bar = doc.getElementById('gb-bar');
    this.rec = doc.getElementById('gb-rec');
    // Stop the canvas from also seeing these clicks as "start the game".
    for (const el of [this.bar, this.rec]) {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('pointerup', (e) => e.stopPropagation());
    }
    this.bar.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'daily') this.onDaily();
      if (act === 'editor') this.onEditor();
      if (act === 'records') this.open();
    });
    this.rec.addEventListener('click', (e) => {
      if (e.target === this.rec || e.target.closest('[data-act="close"]')) return this.close();
      const skin = e.target.closest('[data-skin]')?.dataset.skin;
      if (skin) { this.onSkin(skin); this.render(); }
    });
    doc.addEventListener('keydown', (e) => {
      if (this.isOpen && (e.code === 'Escape' || e.code === 'KeyH')) { e.stopImmediatePropagation(); this.close(); }
    }, true);
  }

  get isOpen() { return this.ok && this.rec.classList.contains('open'); }

  setState(state) {
    if (this.ok) globalThis.document.body.dataset.state = state;
  }

  open() {
    if (!this.ok) return false;
    this.render();
    this.rec.classList.add('open');
    this.rec.querySelector('[data-act="close"]')?.focus();
    return true;
  }

  close() {
    if (!this.ok) return;
    this.rec.classList.remove('open');
    this.onClose?.();
  }

  toggle() { return this.isOpen ? (this.close(), false) : this.open(); }

  render() {
    const p = this.progress;
    const st = p.stats;
    const fmtT = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    const rows = p.scores.map((s, i) => `<tr><td>${i + 1}</td><td><b>${s.score.toLocaleString('en-US')}</b></td><td>${s.level}</td><td>${esc(s.mode)}${s.won ? ' ✓' : ''}</td><td>${esc(s.preset)}</td><td class="muted">${esc(String(s.date).slice(0, 10))}</td></tr>`).join('')
      || '<tr><td colspan="6" class="muted">No runs yet — go set a score.</td></tr>';
    const ach = ACHIEVEMENTS.map((a) => {
      const on = p.isUnlocked(a.id);
      return `<div class="${on ? 'on' : ''}"><b>${on ? '★' : '☆'} ${esc(a.name)}</b><span>${esc(a.desc)}</span></div>`;
    }).join('');
    const skins = SKINS.map((s) => {
      const open = p.skinUnlocked(s);
      const lockName = s.unlock ? ACHIEVEMENTS.find((a) => a.id === s.unlock)?.name : '';
      const sw = s.trail === 'rainbow' ? 'linear-gradient(90deg,#3ce7ff,#ff5ec4,#ffc843,#b6ff45)' : `linear-gradient(90deg,${s.core},${s.trail})`;
      return `<button type="button" data-skin="${s.id}" aria-pressed="${p.skin.id === s.id}" ${open ? '' : 'disabled'} title="${open ? 'Equip' : 'Unlock: ' + esc(lockName)}"><i class="sw" style="background:${sw}"></i>${esc(s.name)}${open ? '' : ' 🔒'}</button>`;
    }).join('');
    const today = p.dailyBest(dayKey());
    this.rec.querySelector('.card').innerHTML = `
      <div class="top"><h2 id="gb-rec-title">RECORDS</h2><button type="button" data-act="close">Close</button></div>
      <p class="muted">${p.unlockedCount}/${ACHIEVEMENTS.length} achievements · today's daily best: ${today ? today.toLocaleString('en-US') : '—'}</p>
      <h3>HIGH SCORES</h3>
      <table><thead><tr><th>#</th><th>Score</th><th>Level</th><th>Mode</th><th>Feel</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table>
      <h3>PADDLE SKINS</h3><div class="skins">${skins}</div>
      <h3>ACHIEVEMENTS</h3><div class="ach">${ach}</div>
      <h3>LIFETIME</h3>
      <div class="stats">
        <div><b>${st.runs}</b><span>Runs</span></div>
        <div><b>${st.bricks.toLocaleString('en-US')}</b><span>Bricks</span></div>
        <div><b>${st.levels}</b><span>Levels cleared</span></div>
        <div><b>${st.flips.toLocaleString('en-US')}</b><span>Gravity flips</span></div>
        <div><b>x${st.bestChain}</b><span>Best chain</span></div>
        <div><b>${st.bosses}</b><span>Bosses</span></div>
        <div><b>${st.portals}</b><span>Portal trips</span></div>
        <div><b>${fmtT(st.time)}</b><span>Play time</span></div>
      </div>`;
  }
}
