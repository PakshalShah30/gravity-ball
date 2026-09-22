/**
 * hud.js — everything that is not the playfield: score band, lives, the
 * gravity-flip charge meter, power-up pills, banners and the full-screen
 * states (title, level clear, game over, pause).
 *
 * The HUD is drawn *without* camera shake so the numbers stay readable while
 * the arena is getting punched.
 */
import { clamp, mixHex, rgba, easeOutCubic, easeOutBack, TAU } from '../core/math.js';
import { VIEW, HUD_H, FIELD, COLORS, FLIP } from '../config.js';

const DROP_LABEL_UI = { wide: 'WIDE', multi: 'MULTI', slow: 'SLOW', grav: 'FLIP+' };

export class Hud {
  constructor() {
    this.lastBannerLevel = -1;
    this.scorePop = 0;
    this.lastScore = 0;
    this.banners = [];
    this.lifePulse = 0;
    this.multPop = 0;
    this.lastMult = 1;
    this.time = 0;
    this.flipPulse = 0;
    this.wasReady = true;
    this.best = 0;
    this.newBest = false;
    this.helpT = 0;
  }

  banner(text, sub = '', time = 1.6, color = COLORS.text) {
    this.banners.push({ text, sub, t: 0, max: time, color });
    if (this.banners.length > 3) this.banners.shift();
  }

  update(dt, world, best) {
    this.time += dt;
    this.best = Math.max(best, world.score);
    const gained = world.score - this.lastScore;
    if (gained > 0) this.scorePop = Math.min(1, this.scorePop + gained / 3000 + 0.25);
    this.lastScore = world.score;
    this.scorePop = Math.max(0, this.scorePop - dt * 3.4);

    if (world.multiplier !== this.lastMult) {
      if (world.multiplier > this.lastMult) this.multPop = 1;
      this.lastMult = world.multiplier;
    }
    this.multPop = Math.max(0, this.multPop - dt * 2.6);

    const ready = world.flipReady || world.flip.active;
    if (ready && !this.wasReady) this.flipPulse = 1;
    this.wasReady = ready;
    this.flipPulse = Math.max(0, this.flipPulse - dt * 2);

    for (let i = this.banners.length - 1; i >= 0; i--) {
      this.banners[i].t += dt;
      if (this.banners[i].t > this.banners[i].max) this.banners.splice(i, 1);
    }
    this.helpT += dt;
  }

  draw(r, world, fx) {
    const t = this.time;
    this._topBand(r, world, t);
    this._footBand(r, world, t);
    this._banners(r, t);
    this._states(r, world, t);
  }

  // ---------------------------------------------------------------- top ----

  _topBand(r, world, t) {
    const inMenu = world.state === 'menu';
    // backdrop plate
    r.rect(0, 0, VIEW.w, HUD_H, { fill: 'rgba(6,9,18,0.92)' });
    r.rect(0, HUD_H - 2, VIEW.w, 2, { fill: rgba(COLORS.accent, 0.35) });
    r.rect(0, HUD_H - 2, VIEW.w, 1, { fill: rgba('#ffffff', 0.5) });

    // ---- score
    r.text('SCORE', 28, 22, { size: 12, weight: 800, color: COLORS.dim, tracking: 3 });
    const pop = easeOutCubic(clamp(this.scorePop, 0, 1));
    const score = Math.round(world.displayScore);
    r.text(score.toLocaleString('en-US'), 28, 52, {
      size: 30 + pop * 5, weight: 900, color: mixHex(COLORS.text, COLORS.gold, pop * 0.5),
      glow: true, glowColor: COLORS.gold, glowWidth: 16 * pop, mono: true,
      scaleX: 1 + pop * 0.03,
    });

    // ---- level + progress (hidden on the title screen: there is no run yet)
    const cx = VIEW.w / 2;
    if (inMenu) {
      r.text('NEON ARCADE BREAKOUT', cx, 30, {
        size: 14, weight: 800, color: rgba(COLORS.accent, 0.85), align: 'center', tracking: 6,
      });
      r.text('canvas 2d · webaudio · no assets', cx, 52, {
        size: 10, weight: 700, color: COLORS.dim, align: 'center', tracking: 3,
      });
      return;
    }
    r.text(`LEVEL ${world.levelIndex}`, cx, 24, {
      size: 15, weight: 800, color: COLORS.text, align: 'center', tracking: 5,
    });
    const total = Math.max(1, world.level.total);
    const done = clamp(1 - world.level.alive / total, 0, 1);
    const bw = 240, bx = cx - bw / 2;
    r.rect(bx, 36, bw, 8, { fill: 'rgba(255,255,255,0.10)', radius: 4 });
    r.rect(bx, 36, Math.max(2, bw * done), 8, {
      fill: mixHex(COLORS.accent, COLORS.gold, done), radius: 4,
    });
    r.rect(bx, 36, bw, 8, { stroke: 'rgba(255,255,255,0.18)', lw: 1, radius: 4 });
    r.text(`${world.level.alive} LEFT`, cx, 62, {
      size: 10, weight: 700, color: COLORS.dim, align: 'center', tracking: 2,
    });

    // ---- best
    r.text('BEST', VIEW.w - 28, 22, { size: 12, weight: 800, color: COLORS.dim, align: 'right', tracking: 3 });
    r.text(Math.max(this.best, world.score).toLocaleString('en-US'), VIEW.w - 28, 44, {
      size: 18, weight: 800, color: rgba(COLORS.text, 0.85), align: 'right', mono: true,
    });

    // ---- lives as ball pips
    for (let i = 0; i < Math.min(world.lives, 8); i++) {
      const px = VIEW.w - 34 - i * 22;
      r.circle(px, 62, 7, { fill: COLORS.ballHue, alpha: 0.9 });
      r.circle(px, 62, 7, { stroke: '#ffffff', lw: 1.2, alpha: 0.7 });
      r.circle(px - 2, 60, 2, { fill: '#ffffff', alpha: 0.95 });
    }
    if (world.lives > 8) {
      r.text(`+${world.lives - 8}`, VIEW.w - 34 - 8 * 22, 62, { size: 12, weight: 800, color: COLORS.dim, align: 'right', baseline: 'middle' });
    }
  }

  // --------------------------------------------------------------- foot ----

  _footBand(r, world, t) {
    const y0 = FIELD.bottom + FIELD.wall;      // 680
    const inMenu = world.state === 'menu';
    r.rect(0, y0, VIEW.w, VIEW.h - y0, { fill: 'rgba(6,9,18,0.92)' });
    r.rect(0, y0, VIEW.w, 2, { fill: rgba(COLORS.flip, 0.3) });

    // ---- gravity flip charge meter
    const mx = 28, my = y0 + 22, mw = 300, mh = 22;
    const f = world.flip;
    const charge = f.active ? f.t / FLIP.duration : f.charge;
    const ready = world.flipReady;
    const pulse = 0.5 + 0.5 * Math.sin(t * (ready ? 9 : 3));

    r.text('GRAVITY FLIP', mx, y0 + 16, {
      size: 11, weight: 800, color: inMenu ? COLORS.dim : ready ? COLORS.flip : COLORS.dim, tracking: 3,
    });
    r.rect(mx, my, mw, mh, { fill: 'rgba(255,255,255,0.07)', radius: 11 });
    const fill = clamp(charge, 0, 1);
    const fillColor = f.active ? '#e6d9ff' : ready ? mixHex(COLORS.flip, '#ffffff', pulse * 0.25) : COLORS.flip;
    r.rect(mx, my, Math.max(4, mw * fill), mh, { fill: fillColor, radius: 11, alpha: f.active ? 0.95 : ready ? 0.9 : 0.7 });
    r.rect(mx, my, mw, mh, { stroke: rgba(ready ? COLORS.flip : '#5a6a86', 0.8), lw: 1.5, radius: 11 });
    if (ready && !f.active) {
      r.rect(mx - 3, my - 3, mw + 6, mh + 6, { stroke: rgba(COLORS.flip, 0.55 * pulse), lw: 2, radius: 13 });
      r.halo(mx + mw / 2, my + mh / 2, mw * 0.62, COLORS.flip, 0.16 + pulse * 0.1 + this.flipPulse * 0.4);
    }
    r.text(inMenu ? 'MOVE · FLIP · CHAIN' : f.active ? 'ANTI-GRAVITY ENGAGED' : ready ? 'READY — SPACE / CLICK' : 'CHARGING…',
      mx + mw + 14, my + mh / 2 + 1, {
        size: 12, weight: 800,
        color: inMenu ? COLORS.dim : f.active ? '#e6d9ff' : ready ? COLORS.flip : COLORS.dim,
        baseline: 'middle', tracking: 1,
      });
    if (f.buff > 0) {
      r.text('FLIP+', mx + mw + 14, my + mh / 2 + 16, { size: 10, weight: 800, color: COLORS.accent, tracking: 2 });
    }

    // ---- power-up pills
    let px = 468;
    const pills = [];
    if (world.buffs.wide > 0) pills.push(['wide', world.buffs.wide / 14]);
    if (world.buffs.slow > 0) pills.push(['slow', world.buffs.slow / 7]);
    for (const [kind, k] of pills) {
      const color = kind === 'wide' ? '#3dffb0' : '#5aa8ff';
      r.rect(px, y0 + 24, 104, 20, { fill: 'rgba(255,255,255,0.07)', radius: 6 });
      r.rect(px, y0 + 24, Math.max(3, 104 * clamp(k, 0, 1)), 20, { fill: rgba(color, 0.35), radius: 6 });
      r.text(DROP_LABEL_UI[kind], px + 8, y0 + 34, { size: 11, weight: 900, color, baseline: 'middle', tracking: 1 });
      px += 114;
    }

    // ---- chain / multiplier readout
    const mult = world.multiplier;
    if (mult > 1) {
      const k = clamp(world.chainTimer / 3.5, 0, 1);
      const cx = VIEW.w - 250;
      const scale = 1 + this.multPop * 0.5;
      r.text(`x${mult}`, cx, y0 + 34, {
        size: 26 * scale, weight: 900, color: COLORS.gold, align: 'right', baseline: 'middle',
        glow: true, glowColor: COLORS.gold, glowWidth: 12 * scale, mono: true,
      });
      r.text('CHAIN', cx + 8, y0 + 28, { size: 10, weight: 800, color: COLORS.dim, tracking: 3 });
      r.rect(cx + 8, y0 + 36, 90, 6, { fill: 'rgba(255,255,255,0.12)', radius: 3 });
      r.rect(cx + 8, y0 + 36, 90 * k, 6, { fill: rgba(COLORS.gold, 0.85), radius: 3 });
      r.text(`${world.chain} HITS`, cx + 8, y0 + 54, { size: 10, weight: 700, color: COLORS.dim, tracking: 1 });
    }

    // ---- hint / touch button
    const hints = world.state === 'play'
      ? 'SPACE = FLIP  ·  P = PAUSE  ·  M = MUTE  ·  R = RESTART'
      : 'MOVE: POINTER / TOUCH / ←→  ·  ACTION: SPACE / CLICK / TAP';
    r.text(hints, VIEW.w - 200, y0 + 62, {
      size: 10, weight: 700, color: rgba(COLORS.dim, 0.75), align: 'right', tracking: 1,
    });
  }

  /** Where the on-screen flip button lives (also used as the touch hit box). */
  static get flipButton() { return { x: 920, y: FIELD.bottom + FIELD.wall + 40, r: 44 }; }

  drawTouchButton(r, world, isTouch, t) {
    if (!isTouch) return;
    const b = Hud.flipButton;
    const ready = world.flipReady;
    const pulse = 0.5 + 0.5 * Math.sin(t * 8);
    r.circle(b.x, b.y, b.r, { fill: ready ? rgba(COLORS.flip, 0.22) : 'rgba(255,255,255,0.05)' });
    r.circle(b.x, b.y, b.r, { stroke: rgba(ready ? COLORS.flip : '#4a5a76', 0.9), lw: 2 });
    if (ready) r.halo(b.x, b.y, b.r * 1.5, COLORS.flip, 0.25 + pulse * 0.15);
    // lightning bolt
    r.poly([
      [b.x + 4, b.y - 20], [b.x - 10, b.y + 2], [b.x - 1, b.y + 2],
      [b.x - 4, b.y + 20], [b.x + 11, b.y - 3], [b.x + 1, b.y - 3],
    ], { fill: ready ? '#ffffff' : '#7d8ba6', alpha: ready ? 0.95 : 0.6 });
  }

  /**
   * Portrait hint. The playfield is authored wide (1000x760), so on a phone
   * held upright it would be a tiny strip in the middle of the screen. Rather
   * than silently shipping a bad layout we ask for a rotation — the game stays
   * visible and playable behind the message.
   */
  drawPortraitHint(r, isPortrait) {
    if (!isPortrait) return;
    const cx = VIEW.w / 2, cy = VIEW.h / 2;
    r.rect(FIELD.x, FIELD.y, FIELD.w, FIELD.h, { fill: 'rgba(4,5,12,0.72)' });
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 3);
    r.circle(cx, cy - 70, 46, { stroke: rgba(COLORS.accent, 0.5 + pulse * 0.4), lw: 3 });
    const sx = Math.cos(this.time * 2) * 4;
    r.poly([[cx - 26 + sx, cy - 86], [cx + 22 + sx, cy - 70], [cx - 26 + sx, cy - 54]],
      { fill: COLORS.accent, alpha: 0.9 });
    r.text('ROTATE YOUR DEVICE', cx, cy + 20, {
      size: 30, weight: 900, align: 'center', baseline: 'middle', color: '#ffffff', tracking: 4,
      glow: true, glowColor: COLORS.accent, glowWidth: 18,
    });
    r.text('gravity ball plays in landscape', cx, cy + 52, {
      size: 13, weight: 700, align: 'center', color: rgba(COLORS.text, 0.8), tracking: 3,
    });
  }

  // ------------------------------------------------------------- banners ---

  _banners(r, t) {
    const cx = VIEW.w / 2;
    for (let i = 0; i < this.banners.length; i++) {
      const b = this.banners[i];
      const k = b.t / b.max;
      const inK = clamp(b.t / 0.28, 0, 1);
      const outK = clamp((k - 0.72) / 0.28, 0, 1);
      const scale = easeOutBack(inK) * (1 - outK * 0.25);
      const alpha = inK * (1 - outK);
      const y = FIELD.y + 210 + i * 54;
      r.text(b.text, cx, y, {
        size: 40 * scale, weight: 900, align: 'center', baseline: 'middle',
        color: b.color, alpha, tracking: 3,
        glow: true, glowColor: b.color, glowWidth: 22 * scale, glowAmt: 1,
        scaleY: 1, scaleX: 1,
      });
      if (b.sub) {
        r.text(b.sub, cx, y + 30 + 8 * inK, {
          size: 14, weight: 700, align: 'center', baseline: 'middle',
          color: rgba(COLORS.text, 0.8), alpha: alpha * 0.95, tracking: 4,
        });
      }
    }
  }

  // -------------------------------------------------------------- states ---

  _states(r, world, t) {
    switch (world.state) {
      case 'menu': this._menu(r, world, t); break;
      case 'ready': this._ready(r, world, t); break;
      case 'clear': this._clear(r, world, t); break;
      case 'gameover': this._gameOver(r, world, t); break;
      case 'paused': this._pause(r, world, t); break;
      default: break;
    }
    if (world.paused && world.state !== 'menu') this._pause(r, world, t);
  }

  _veil(r, alpha) {
    r.rect(FIELD.x, FIELD.y, FIELD.w, FIELD.h, { fill: `rgba(4,5,12,${alpha})` });
  }

  _titleWord(r, txt, cx, y, size, color, t, phase) {
    // per-letter wave + glow, drawn by hand so it looks designed
    const track = size * 0.08;
    let total = 0;
    const widths = [];
    for (const ch of txt) { const w = r.measure(ch, size, 900, false) + track; widths.push(w); total += w; }
    let x = cx - total / 2;
    for (let i = 0; i < txt.length; i++) {
      const wave = Math.sin(t * 2.2 + i * 0.5 + phase) * size * 0.035;
      const hot = 0.5 + 0.5 * Math.sin(t * 1.6 + i * 0.9);
      r.text(txt[i], x + widths[i] / 2, y + wave, {
        size, weight: 900, align: 'center', baseline: 'middle', mono: false,
        color, glow: true, glowColor: color, glowWidth: size * (0.22 + hot * 0.12), glowAmt: 0.8,
        scaleY: 1 + wave * 0.004,
      });
      x += widths[i];
    }
    return total;
  }

  _menu(r, world, t) {
    this.banners.length = 0;      // the title has its own type
    this._veil(r, 0.5);

    // A soft "stage" behind the logo. Without it the title type sits straight
    // on top of the brick field and both become unreadable; with it the logo
    // reads cleanly while the bricks stay colourful and alive underneath.
    const stageY = 120, stageH = 250;
    const g = r.ctx.createLinearGradient(0, stageY, 0, stageY + stageH);
    g.addColorStop(0, 'rgba(4,5,12,0)');
    g.addColorStop(0.28, 'rgba(4,5,12,0.86)');
    g.addColorStop(0.72, 'rgba(4,5,12,0.86)');
    g.addColorStop(1, 'rgba(4,5,12,0)');
    r.ctx.save();
    r.ctx.fillStyle = g;
    r.ctx.fillRect(FIELD.x, stageY, FIELD.w, stageH);
    r.ctx.restore();

    const cx = VIEW.w / 2;
    const bob = Math.sin(t * 1.4) * 6;
    this._titleWord(r, 'GRAVITY', cx, 208 + bob, 74, '#eaf6ff', t, 0);
    this._titleWord(r, 'BALL', cx, 290 + bob, 74, COLORS.accent, t, 1.2);
    r.text('a juiced-up arcade breakout', cx, 342 + bob, {
      size: 15, weight: 700, color: rgba(COLORS.flip, 0.95), align: 'center', tracking: 6,
    });

    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    r.text('CLICK  /  TAP  TO  START', cx, 442, {
      size: 24, weight: 900, color: mixHex(COLORS.text, COLORS.gold, pulse * 0.6),
      align: 'center', tracking: 4, glow: true, glowColor: COLORS.gold, glowWidth: 10 + pulse * 8,
    });
    r.text('space also works', cx, 470, { size: 11, weight: 700, color: COLORS.dim, align: 'center', tracking: 2 });

    const lines = [
      ['MOVE', 'pointer · touch · ←→ keys'],
      ['FLIP GRAVITY', 'space · click · tap (double damage!)'],
      ['GOAL', 'clear every brick — chain hits for x16 score'],
    ];
    let y = 528;
    for (const [k, v] of lines) {
      r.text(k, cx - 130, y, { size: 12, weight: 900, color: COLORS.accent, align: 'right', tracking: 2 });
      r.text(v, cx - 108, y, { size: 12, weight: 600, color: rgba(COLORS.text, 0.85), tracking: 1 });
      y += 26;
    }
    r.text(`BEST  ${Math.max(this.best, world.score).toLocaleString('en-US')}`, cx, 636, {
      size: 14, weight: 800, color: COLORS.gold, align: 'center', tracking: 4, alpha: 0.9,
    });
  }

  _ready(r, world, t) {
    if (world.state !== 'ready') return;
    // Announce each level exactly once, even though the state machine can enter
    // "ready" several times (after a life is lost, for instance).
    if (world.stateT > 0.25 && this.lastBannerLevel !== world.levelIndex) {
      this.lastBannerLevel = world.levelIndex;
      this.banner(`LEVEL ${world.levelIndex}`, world.levelIndex === 1 ? 'GO' : '', 1.3, COLORS.accent);
    }
    const cx = VIEW.w / 2;
    const k = clamp(world.stateT / 0.5, 0, 1);
    r.text(`LEVEL ${world.levelIndex}`, cx, FIELD.y + 150, {
      size: 46 * (0.6 + 0.4 * easeOutCubic(k)), weight: 900, align: 'center', baseline: 'middle',
      color: '#ffffff', alpha: k, tracking: 6,
      glow: true, glowColor: COLORS.accent, glowWidth: 26, glowAmt: 1,
    });
    const hint = world.levelIndex === 1
      ? 'BREAK EVERY BRICK'
      : world.levelIndex % 3 === 0 ? 'BOMBS CHAIN — USE THEM' : 'ANTI-GRAVITY DEALS DOUBLE DAMAGE';
    r.text(hint, cx, FIELD.y + 190, {
      size: 14, weight: 700, color: rgba(COLORS.text, 0.8), align: 'center', alpha: k, tracking: 4,
    });
    const pulse = 0.5 + 0.5 * Math.sin(t * 5);
    r.text(world.stateT > 6 ? 'LAUNCHING…' : 'CLICK / SPACE TO LAUNCH', cx, FIELD.y + 470, {
      size: 20, weight: 900, align: 'center', color: mixHex(COLORS.text, COLORS.accent, pulse),
      tracking: 3, glow: true, glowColor: COLORS.accent, glowWidth: 8 + pulse * 8,
    });
  }

  _clear(r, world, t) {
    const cx = VIEW.w / 2;
    const k = clamp(world.stateT / 0.35, 0, 1);
    const s = easeOutBack(k);
    this._veil(r, 0.35 * k);
    r.text('LEVEL CLEAR', cx, FIELD.y + 230, {
      size: 54 * (0.7 + 0.3 * s), weight: 900, align: 'center', baseline: 'middle',
      color: '#ffffff', alpha: k, tracking: 8,
      glow: true, glowColor: COLORS.gold, glowWidth: 30, glowAmt: 1,
    });
    r.text(`LEVEL ${world.levelIndex} → ${world.levelIndex + 1}`, cx, FIELD.y + 280, {
      size: 16, weight: 800, color: COLORS.gold, align: 'center', alpha: k, tracking: 5,
    });
    const bonus = 1000 + world.lives * 250;
    r.text(`CLEAR BONUS +${bonus.toLocaleString('en-US')}`, cx, FIELD.y + 330, {
      size: 20, weight: 900, color: COLORS.accent, align: 'center', alpha: k, tracking: 2,
    });
    if (world.flipReady) {
      r.text('FLIP BONUS +500', cx, FIELD.y + 362, { size: 14, weight: 800, color: COLORS.flip, align: 'center', alpha: k, tracking: 2 });
    }
    // confetti arcs
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU + t * 0.4;
      const rr = 120 + Math.sin(t * 2 + i) * 30;
      r.circle(cx + Math.cos(a) * rr * 1.9, FIELD.y + 240 + Math.sin(a) * rr, 3, {
        fill: COLORS.brick[i % COLORS.brick.length], alpha: 0.5 + 0.5 * Math.sin(t * 6 + i),
      });
    }
  }

  _gameOver(r, world, t) {
    const k = clamp(world.stateT / 0.6, 0, 1);
    this._veil(r, 0.7 * k);
    const cx = VIEW.w / 2;
    r.text('GAME OVER', cx, FIELD.y + 190, {
      size: 58, weight: 900, align: 'center', baseline: 'middle',
      color: '#ffffff', alpha: k, tracking: 8,
      glow: true, glowColor: COLORS.danger, glowWidth: 30, glowAmt: 1,
    });
    const st = world.runStats ?? { score: world.score, level: world.levelIndex, bricks: world.bricksBroken, multiplier: world.bestMultiplier, time: world.runTime, flips: world.flipsUsed };
    const rows = [
      ['SCORE', st.score.toLocaleString('en-US')],
      ['LEVEL REACHED', String(st.level)],
      ['BRICKS BROKEN', String(st.bricks)],
      ['BEST CHAIN', `x${st.multiplier}`],
      ['GRAVITY FLIPS', String(st.flips)],
      ['TIME', fmtTime(st.time)],
    ];
    let y = FIELD.y + 250;
    const w = 320;
    r.rect(cx - w / 2, y - 24, w, rows.length * 30 + 22, { fill: 'rgba(8,12,22,0.75)', radius: 10 });
    r.rect(cx - w / 2, y - 24, w, rows.length * 30 + 22, { stroke: 'rgba(255,255,255,0.10)', lw: 1, radius: 10 });
    for (const [kk, vv] of rows) {
      r.text(kk, cx - w / 2 + 20, y, { size: 12, weight: 800, color: COLORS.dim, alpha: k, tracking: 2 });
      r.text(vv, cx + w / 2 - 20, y, { size: 16, weight: 900, color: '#ffffff', align: 'right', alpha: k, mono: true });
      y += 30;
    }
    if (world.stateT > 0.9) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 5);
      r.text('CLICK / SPACE TO PLAY AGAIN', cx, FIELD.y + 500, {
        size: 22, weight: 900, align: 'center', color: mixHex(COLORS.text, COLORS.accent, pulse),
        tracking: 3, glow: true, glowColor: COLORS.accent, glowWidth: 10 + pulse * 10,
      });
      r.text('R = NEW RUN    ·    ESC = PAUSE', cx, FIELD.y + 534, {
        size: 11, weight: 700, color: COLORS.dim, align: 'center', tracking: 2,
      });
    }
  }

  _pause(r, world, t) {
    this._veil(r, 0.72);
    const cx = VIEW.w / 2;
    r.text('PAUSED', cx, FIELD.y + 300, {
      size: 52, weight: 900, align: 'center', baseline: 'middle', color: '#ffffff', tracking: 10,
      glow: true, glowColor: COLORS.accent, glowWidth: 26,
    });
    r.text('P / ESC TO RESUME   ·   R TO RESTART   ·   M TO MUTE', cx, FIELD.y + 348, {
      size: 12, weight: 700, color: rgba(COLORS.text, 0.75), align: 'center', tracking: 3,
    });
  }
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss < 10 ? '0' : ''}${ss}`;
}
