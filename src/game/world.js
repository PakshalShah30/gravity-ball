/**
 * world.js — the simulation: ball physics, collisions, scoring, gravity flips,
 * power-ups, level flow and every piece of feedback a hit triggers.
 *
 * Physics notes:
 *  - The ball is integrated with semi-implicit Euler inside fixed 1/120 s
 *    steps, but *position* is resolved by continuous collision detection
 *    (swept circle vs AABB) so a 1400 px/s ball can never tunnel.
 *  - Gravity is the whole point of the game: the ball arcs, so the player has
 *    to lead shots. Flipping gravity is the moment-to-moment "wow" button and
 *    a clutch save tool.
 */
import { clamp, damp, mixHex, rgba, TAU, sign, sweepCircleBox, makeRng } from '../core/math.js';
import { emitGravityWind } from '../core/fx.js';
import {
  BALL, PADDLE, FIELD, FLIP, COMBO, SCORING, DROPS, LIVES_START, TIMING,
  JUICE, COLORS,
} from '../config.js';
import { Level, KIND } from './level.js';
import { Paddle } from './paddle.js';

export const STATE = {
  MENU: 'menu',
  READY: 'ready',
  PLAY: 'play',
  CLEAR: 'clear',
  DYING: 'dying',
  GAME_OVER: 'gameover',
};

const DROP_LABEL = { wide: 'W', multi: 'M', slow: 'S', grav: 'G', points: '$' };
const DROP_COLOR = { wide: '#3dffb0', multi: '#ffc843', slow: '#5aa8ff', grav: '#a06bff', points: '#ff5ec4' };
export const DROP_INFO = { DROP_LABEL, DROP_COLOR };

const TRAIL_N = 26;

class Ball {
  constructor() {
    this.r = BALL.r;
    this.x = 500; this.y = 600;
    this.vx = 0; this.vy = 0;
    this.speed = 0;
    this.stuck = false;       // glued to the paddle before launch
    this.spin = 0;
    this.squash = 0;
    this.flash = 0;
    this.born = 0;
    this.dead = false;
    this.trailX = new Float32Array(TRAIL_N);
    this.trailY = new Float32Array(TRAIL_N);
    this.trailHead = 0;
    this.trailLen = 0;
  }

  reset(x, y) {
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.speed = 0;
    this.stuck = true;
    this.spin = 0;
    this.squash = 0;
    this.flash = 0;
    this.dead = false;
    this.trailLen = 0;
    this.trailHead = 0;
  }

  sampleTrail() {
    this.trailX[this.trailHead] = this.x;
    this.trailY[this.trailHead] = this.y;
    this.trailHead = (this.trailHead + 1) % TRAIL_N;
    if (this.trailLen < TRAIL_N) this.trailLen++;
  }
}

export class World {
  constructor({ fx, particles, audio, renderer }) {
    this.fx = fx;
    this.particles = particles;
    this.audio = audio;
    this.r = renderer;

    this.level = new Level();
    this.paddle = new Paddle();
    this.balls = [];
    this.main = this._newBall();

    this.state = STATE.MENU;
    this.stateT = 0;
    this.t = 0;
    this.paused = false;
    this.slow = 1;                 // global time scale from power-ups

    this.score = 0;
    this.displayScore = 0;
    this.lives = LIVES_START;
    this.levelIndex = 1;
    this.seed = 1;
    this.chain = 0;
    this.multiplier = 1;
    this.chainTimer = 0;
    this.bestMultiplier = 1;
    this.bricksBroken = 0;
    this.flipsUsed = 0;
    this.runTime = 0;
    this.livesAwarded = 0;

    this.flip = { active: false, t: 0, charge: 1, accel: 0, buff: 0 };
    this.gravity = BALL.gravity;
    this.buffs = { wide: 0, slow: 0 };
    this.pendingBlasts = [];
    this.drops = [];
    this.popups = [];
    this.runStats = null;
    this.onEvent = null;
    this._scratch = [];
    this._cellBox = { x: 0, y: 0, w: 0, h: 0 };
  }

  _newBall() {
    const b = new Ball();
    b.reset(FIELD.x + FIELD.w / 2, PADDLE.y - BALL.r - 2);
    this.balls.push(b);
    return b;
  }

  get bricksLeft() { return this.level.alive; }
  get flipReady() { return this.flip.charge >= 1; }
  /** 0..1: how close the lowest ball is to the pit. Drives red screen glow. */
  get danger() { return this._danger(); }

  // ================================================================= flow ===

  toMenu() {
    this.state = STATE.MENU;
    this.stateT = 0;
    this.level.build(1, this.seed);
    this.level.startIntro();
    this.balls.length = 0;
    this.main = this._newBall();
    this.drops.length = 0;
    this.popups.length = 0;
    this.pendingBlasts.length = 0;
  }

  startRun(seed = (Math.random() * 1e9) | 0) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.score = 0;
    this.displayScore = 0;
    this.lives = LIVES_START;
    this.levelIndex = 1;
    this.livesAwarded = 0;
    this.chain = 0;
    this.multiplier = 1;
    this.bestMultiplier = 1;
    this.bricksBroken = 0;
    this.flipsUsed = 0;
    this.runTime = 0;
    this.buffs.wide = 0;
    this.buffs.slow = 0;
    this.flip.charge = 1;
    this.flip.buff = 0;
    this.flip.active = false;
    this.paddle.resize('normal');
    this.startLevel(1);
    this.audio?.setLevel(1);
    this.audio?.setIntensity(0);
    this._emit('runStart');
  }

  startLevel(index) {
    this.levelIndex = index;
    this.level.build(index, this.seed);
    this.level.startIntro();
    this.gravity = BALL.gravity + (index - 1) * BALL.gravityPerLevel;
    this.balls.length = 0;
    this.main = this._newBall();
    this.drops.length = 0;
    this.chain = 0;
    this.multiplier = 1;
    this._setState(STATE.READY);
    this.audio?.setLevel(index);
    this._emit('levelStart', index);
  }

  _setState(s) {
    this.state = s;
    this.stateT = 0;
  }

  nextLevel() {
    const bonus = SCORING.levelClear + this.lives * SCORING.lifeBonus
      + (this.flipReady ? SCORING.flipBonus : 0);
    this.addScore(bonus, FIELD.x + FIELD.w / 2, FIELD.y + 260, `LEVEL CLEAR +${bonus}`, COLORS.gold, 26);
    this.startLevel(this.levelIndex + 1);
  }

  loseLife() {
    this.lives--;
    this.audio?.life();
    this.fx.shake(JUICE.shakeLife);
    this.fx.flashScreen(COLORS.danger, 0.45);
    this.fx.chroma(1.2);
    this.fx.slowmo(0.35, 0.7);
    this._emit('lifeLost', this.lives);
    if (this.lives <= 0) {
      this.runStats = {
        score: this.score, level: this.levelIndex, bricks: this.bricksBroken,
        multiplier: this.bestMultiplier, time: this.runTime, flips: this.flipsUsed,
      };
      this._setState(STATE.GAME_OVER);
      this.audio?.gameOver();
      this._emit('gameOver', this.runStats);
    } else {
      this._setState(STATE.DYING);
    }
  }

  // ================================================================= input ===

  /** The single context-sensitive action: launch / flip / retry. */
  primaryAction() {
    switch (this.state) {
      case STATE.MENU: this.audio?.unlock(); this.startRun(); break;
      case STATE.READY: this.launch(); break;
      case STATE.PLAY: this.activateFlip(); break;
      case STATE.GAME_OVER:
        if (this.stateT > 0.9) this.startRun();
        break;
      case STATE.CLEAR: break;
      default: break;
    }
  }

  launch() {
    const b = this.main;
    if (!b || !b.stuck) return;
    const speed = this.ballSpeed();
    const angle = (-70 + this.rng() * 40) * Math.PI / 180;
    b.vx = Math.cos(angle) * speed * (this.rng() < 0.5 ? -1 : 1);
    b.vy = -Math.abs(Math.sin(angle) * speed);
    b.stuck = false;
    b.born = 0;
    this.audio?.launch();
    this.particles.ring(b.x, b.y, COLORS.accent, 6, 42, 0.4, 2, 0.8);
    this.particles.burst(b.x, b.y, { count: 14, speed: [60, 260], color: COLORS.accent, life: 0.4, size: 2.6, glow: 1 });
    this._setState(STATE.PLAY);
  }

  ballSpeed() {
    return clamp(BALL.speed + (this.levelIndex - 1) * BALL.speedPerLevel, BALL.speed, BALL.speedMax);
  }

  // =============================================================== gravity ===

  activateFlip() {
    if (!this.flipReady || this.state !== STATE.PLAY) return false;
    const f = this.flip;
    f.active = true;
    f.t = FLIP.duration;
    f.charge = 0;
    // The yank scales with the current speed, so the flip always reverses the
    // ball decisively (and never feels useless when the ball is fast).
    let speed = 0;
    for (const b of this.balls) speed = Math.max(speed, Math.hypot(b.vx, b.vy));
    f.accel = -clamp((speed * 2.4) / FLIP.duration, 1200, 6200);
    this.flipsUsed++;
    this.gravity = f.accel;

    this.audio?.flip();
    this.audio?.setFlipActive(true);
    this.fx.shake(JUICE.shakeFlip);
    this.fx.freeze(FLIP.hitstop);
    this.fx.slowmo(FLIP.slowmoScale, FLIP.slowmoTime);
    this.fx.flashScreen(COLORS.flip, 0.34);
    this.fx.chroma(1.1);
    this.fx.punch(0.012);

    const cx = FIELD.x + FIELD.w / 2, cy = FIELD.y + FIELD.h / 2;
    this.particles.ring(cx, cy, COLORS.flip, 40, 700, 0.7, 5, 0.55);
    for (const b of this.balls) {
      this.particles.ring(b.x, b.y, COLORS.flip, b.r, 130, 0.5, 4, 0.9);
      this.particles.burst(b.x, b.y, { count: 22, speed: [140, 520], color: COLORS.flip, life: 0.6, size: 3, glow: 1, grav: -900 });
      // A flip also nudges the ball faster: power at a price.
      b.vx *= FLIP.speedBoost; b.vy *= FLIP.speedBoost;
    }
    this._popup(this.main.x, this.main.y - 40, 'GRAVITY FLIP', COLORS.flip, 22, 1.2);
    return true;
  }

  _endFlip() {
    const f = this.flip;
    f.active = false;
    f.t = 0;
    f.charge = 0;   // the flip goes on cooldown: it is a resource, not a toggle
    this.gravity = BALL.gravity + (this.levelIndex - 1) * BALL.gravityPerLevel;
    this.audio?.flipLand();
    this.audio?.setFlipActive(false);
    this.fx.shake(0.22);
    this.particles.ring(this.main.x, this.main.y, COLORS.flip, 10, 90, 0.35, 3, 0.6);
    for (const b of this.balls) {
      this.particles.burst(b.x, b.y, { count: 10, speed: [30, 160], color: COLORS.flip, life: 0.4, size: 2.4, glow: 1, grav: 700 });
    }
  }

  _flipRechargeTime() { return FLIP.cooldown * (this.flip.buff > 0 ? 0.45 : 1); }

  // ================================================================ update ===

  update(dt, input) {
    this.t += dt;
    this.stateT += dt;
    if (this.state === STATE.PLAY) this.runTime += dt;

    // pointer steering is always live so the paddle feels connected
    this.paddle.update(dt, input, this.state === STATE.PLAY || this.state === STATE.READY);

    if (input.primary) this.primaryAction();
    if (input.gravityButton) this.activateFlip();

    switch (this.state) {
      case STATE.MENU: this._updateMenu(dt); break;
      case STATE.READY: this._updateReady(dt); break;
      case STATE.PLAY: this._updatePlay(dt); break;
      case STATE.CLEAR: this._updateClear(dt); break;
      case STATE.DYING: this._updateDying(dt); break;
      case STATE.GAME_OVER: this._updateGameOver(dt); break;
    }

    // Chain reactions and power-ups keep resolving in every state: a bomb that
    // was triggered while the ball was alive must not be swallowed by a death.
    this._updateBlasts(dt);
    if (this.state === STATE.PLAY && this.level.alive === 0) this._onLevelCleared();

    // Timers shared by every state
    this.displayScore = damp(this.displayScore, this.score, 9, dt);
    if (this.level.clearing) this.level.cleared = Math.min(1, this.level.cleared + dt * 2);
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.life += dt;
      p.y += p.vy * dt;
      p.vy += p.grav * dt;
      if (p.life >= p.maxLife) this.popups.splice(i, 1);
    }
  }

  _updateMenu(dt) {
    this.level.update(dt, 1);
    // Idle demo: the ball drifts around behind the menu so the scene moves.
    this.main.x = FIELD.x + FIELD.w / 2 + Math.sin(this.t * 0.7) * 220;
    this.main.y = FIELD.y + 300 + Math.cos(this.t * 1.1) * 90;
    this.main.sampleTrail();
  }

  _updateReady(dt) {
    const b = this.main;
    if (b) {
      b.x = clamp(this.paddle.x, FIELD.x + b.r, FIELD.x + FIELD.w - b.r);
      b.y = this.paddle.top - b.r - 2;
      b.sampleTrail();
      b.flash = damp(b.flash, 0, 5, dt);
    }
    this.level.update(dt, 1);
    this._updateDrops(dt);
    // Auto-launch after a while so a distracted player is never stuck.
    if (this.stateT > 6 && this.level.introDone) this.launch();
  }

  _updatePlay(dt) {
    // -------- gravity flip window
    const f = this.flip;
    if (f.active) {
      f.t -= dt;
      this.gravity = f.accel;
      emitGravityWind(this.particles, dt, -1, 1, FIELD);
      if (f.t <= 0) this._endFlip();
    } else {
      f.charge = Math.min(1, f.charge + dt / this._flipRechargeTime());
      this.gravity = BALL.gravity + (this.levelIndex - 1) * BALL.gravityPerLevel;
    }
    if (f.buff > 0) f.buff = Math.max(0, f.buff - dt);

    // -------- buffs
    if (this.buffs.wide > 0) {
      this.buffs.wide -= dt;
      if (this.buffs.wide <= 0) { this.paddle.resize('normal'); this._popup(this.paddle.x, this.paddle.y - 40, 'NARROW', COLORS.dim, 16, 0.8); }
    }
    if (this.buffs.slow > 0) {
      this.buffs.slow -= dt;
      if (this.buffs.slow <= 0) this._scaleSpeeds(1 / 0.72);
    }

    // -------- combo decay
    if (this.chain > 0) {
      this.chainTimer -= dt;
      if (this.chainTimer <= 0) this._resetChain();
    }

    // -------- ball(s)
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      if (b.dead) continue;
      b.born += dt;
      this._stepBall(b, dt);
      b.sampleTrail();
      b.flash = damp(b.flash, 0, 6, dt);
      b.squash = damp(b.squash, 0, 11, dt);
      b.spin += (b.vx * 0.0016) * dt * 60;
      if (!b.stuck) this._ballTrailFx(b);
      if (b.dead) this._killBall(b, i);
    }

    this.level.update(dt, this.flip.active ? -1 : 1);
    this._updateDrops(dt);

    // -------- win / lose conditions
    if (this.state === STATE.PLAY && this.balls.length === 0) this.loseLife();
  }

  _updateClear(dt) {
    this.level.update(dt, 1);
    this.ballFloat(dt);
    this._updateDrops(dt);
    if (this.stateT > TIMING.clearDelay) this.nextLevel();
  }

  _updateDying(dt) {
    this.level.update(dt, 1);
    this._updateDrops(dt);
    if (this.stateT > TIMING.readyDelay) {
      this.main = this._newBall();
      this.main.x = this.paddle.x;
      this.main.y = this.paddle.top - this.main.r - 2;
      this._setState(STATE.READY);
    }
  }

  _updateGameOver(dt) {
    this.level.update(dt, 1);
    this._updateDrops(dt);
    if (this.stateT > TIMING.readyDelay) this.ballFloat(dt);
  }

  /** Slow drifting ball used by the clear / gameover screens. */
  ballFloat(dt) {
    const b = this.main;
    if (!b) return;
    b.x += Math.sin(this.t * 0.9) * 30 * dt;
    b.y += Math.cos(this.t * 1.3) * 24 * dt;
    b.sampleTrail();
  }

  // ============================================================== ball step ===

  _stepBall(b, dt) {
    if (b.stuck) return;
    const left = FIELD.x + b.r, right = FIELD.x + FIELD.w - b.r;
    const top = FIELD.y + b.r, bottom = FIELD.bottom - b.r;
    let remaining = dt;
    let guard = 0;

    while (remaining > 1e-6 && guard++ < 6 && !b.dead) {
      const h = Math.min(remaining, 1 / 90);
      b.vy += this.gravity * h;
      const dx = b.vx * h, dy = b.vy * h;
      const speed = Math.hypot(b.vx, b.vy);

      // ---- candidates
      let bestT = 1, kind = null, brick = null, nx = 0, ny = 0;
      if (dx < 0) { const t = (left - b.x) / dx; if (t >= 0 && t <= bestT) { bestT = t; kind = 'wall'; nx = 1; ny = 0; } }
      if (dx > 0) { const t = (right - b.x) / dx; if (t >= 0 && t <= bestT) { bestT = t; kind = 'wall'; nx = -1; ny = 0; } }
      if (dy < 0) { const t = (top - b.y) / dy; if (t >= 0 && t <= bestT) { bestT = t; kind = 'ceiling'; nx = 0; ny = 1; } }
      if (dy > 0) { const t = (bottom - b.y) / dy; if (t >= 0 && t <= bestT) { bestT = t; kind = 'pit'; } }

      // paddle (only catchable while the ball is falling)
      if (dy > 0) {
        const pb = this.paddle;
        const box = this._cellBox;
        box.x = pb.x - pb.w / 2; box.y = pb.y - pb.h / 2; box.w = pb.w; box.h = pb.h + 8;
        const hit = sweepCircleBox(b.x, b.y, dx, dy, b.r, box);
        if (hit && hit.t <= bestT) { bestT = hit.t; kind = 'paddle'; nx = hit.nx; ny = hit.ny; }
      }

      // bricks (swept AABB -> candidate cells -> exact swept test)
      const sx0 = Math.min(b.x, b.x + dx) - b.r, sx1 = Math.max(b.x, b.x + dx) + b.r;
      const sy0 = Math.min(b.y, b.y + dy) - b.r, sy1 = Math.max(b.y, b.y + dy) + b.r;
      const list = this.level.collectSwept(sx0, sy0, sx1, sy1, this._scratch);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const hit = sweepCircleBox(b.x, b.y, dx, dy, b.r, c);
        if (hit && hit.t <= bestT) { bestT = hit.t; kind = 'brick'; brick = c; nx = hit.nx; ny = hit.ny; }
      }

      // ---- advance to the contact point
      const used = Math.max(h * bestT, 0);
      b.x += dx * bestT;
      b.y += dy * bestT;
      b.speed = speed;
      remaining -= used;

      if (kind === null) continue;

      // ---- resolve
      if (kind === 'brick') {
        b.vx -= 2 * (b.vx * nx + b.vy * ny) * nx;
        b.vy -= 2 * (b.vx * nx + b.vy * ny) * ny;
        b.x += nx * 0.4; b.y += ny * 0.4;
        this._hitBrick(brick, b, nx, ny, speed);
        this._bumpBall(b, BALL.bumpPerHit);
      } else if (kind === 'paddle') {
        const res = this.paddle.reflect(b);
        this.paddle.onHit(clamp(speed / this.ballSpeed(), 0.5, 2));
        this.audio?.paddle(res.offset, speed);
        this.fx.shake(JUICE.shakePaddle, nx, 0);
        this.fx.freeze(JUICE.hitstopPaddle);
        this.particles.burst(b.x, b.y, {
          count: 10, speed: [80, 320], color: COLORS.paddle, life: 0.35, size: 2.6, glow: 1,
          angle: -Math.PI / 2, spread: 2.2,
        });
        this.particles.ring(b.x, this.paddle.top, COLORS.paddle, 6, 46, 0.3, 2, 0.7);
        b.squash = 0.5;
        this._returnBonus();
      } else if (kind === 'pit') {
        b.dead = true;
        b.y = FIELD.bottom - b.r;
      } else {
        // wall / ceiling
        if (nx) b.vx = -b.vx; else b.vy = -b.vy;
        if (nx) b.x += nx * 0.4; else b.y += ny * 0.4;
        // never allow a purely horizontal or vertical crawl
        if (Math.abs(b.vx) < speed * 0.16) { b.vx = sign(b.vx || nx || 1) * speed * 0.16; }
        if (Math.abs(b.vy) < speed * 0.10) { b.vy = sign(b.vy || ny || 1) * speed * 0.10; }
        this._bounceFx(b, kind, speed);
      }

      this._clampSpeed(b);
    }

    // Stuck-ball watchdog: if the ball has been nearly horizontal for a while,
    // nudge it so the game can never lock up.
    if (!b.stuck) {
      if (Math.abs(b.vy) < 46) b.stuckT = (b.stuckT ?? 0) + dt; else b.stuckT = 0;
      if (b.stuckT > 1.6) {
        b.stuckT = 0;
        b.vy += sign(b.vy || -1) * 130;
        this._clampSpeed(b);
        this.particles.burst(b.x, b.y, { count: 8, speed: [30, 120], color: COLORS.accent, life: 0.3, size: 2, glow: 1 });
      }
    }
  }

  _clampSpeed(b) {
    const sp = Math.hypot(b.vx, b.vy);
    const max = Math.min(BALL.speedMax, this.ballSpeed() * 1.5);
    const min = Math.min(BALL.speedMin, this.ballSpeed() * 0.7);
    if (sp > max) { b.vx *= max / sp; b.vy *= max / sp; }
    else if (sp < min && sp > 0.01) { b.vx *= min / sp; b.vy *= min / sp; }
    b.speed = Math.hypot(b.vx, b.vy);
  }

  _bumpBall(b, k) {
    b.vx *= k; b.vy *= k;
    this._clampSpeed(b);
  }

  _scaleSpeeds(k) {
    for (const b of this.balls) {
      b.vx *= k; b.vy *= k;
      this._clampSpeed(b);
    }
  }

  _bounceFx(b, kind, speed) {
    const v = clamp(speed / 1200, 0.2, 1.4);
    this.fx.shake(JUICE.shakeWall * v, 0, kind === 'ceiling' ? 1 : -1);
    const color = kind === 'ceiling' ? COLORS.accent : COLORS.paddle;
    this.audio?.wall(speed, (b.x - FIELD.x) / FIELD.w * 2 - 1);
    this.particles.burst(b.x, b.y, {
      count: kind === 'ceiling' ? 12 : 7,
      speed: [60, 220 * v], color, life: 0.3, size: 2.2, glow: 1,
      angle: kind === 'ceiling' ? Math.PI / 2 : (b.x < FIELD.x + FIELD.w / 2 ? 0 : Math.PI),
      spread: 1.6,
    });
    b.squash = 0.3;
    if (kind === 'ceiling' && this.flip.active) {
      // Slamming into the ceiling during a flip is the signature move.
      this.fx.shake(0.5);
      this.fx.flashScreen(COLORS.flip, 0.3);
      this.fx.freeze(0.045);
      this.fx.chroma(0.8);
      this.particles.ring(b.x, FIELD.y + b.r, COLORS.flip, 12, 300, 0.55, 5, 0.9);
      this.particles.burst(b.x, FIELD.y + b.r, { count: 30, speed: [200, 700], color: '#e0d4ff', life: 0.6, size: 3, glow: 1, angle: Math.PI / 2, spread: 2.6, grav: 500 });
      this.audio?.explode(0.9, 0.5);
      // Bricks near the ceiling take collateral damage.
      this.level.forEachInBox(b.x - 120, FIELD.y, b.x + 120, FIELD.y + 70, (br) => {
        this._queueBlast(br, b.x, FIELD.y, 0);
      });
    }
  }

  _ballTrailFx(b) {
    // Embers peeling off a fast ball + a soft light halo behind it.
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > 420 && Math.random() < 0.55) {
      this.particles.ember(b.x - b.vx * 0.012, b.y - b.vy * 0.012,
        this.flip.active ? COLORS.flip : COLORS.ballHue, 40, 0.45);
    }
    this.fx.addGlow(b.x, b.y, b.r * 5.5, this.flip.active ? COLORS.flip : COLORS.ballHue, this.flip.active ? 1 : 0.85);
  }

  // ============================================================== collisions ===

  _hitBrick(brick, ball, nx, ny, speed) {
    const cx = ball.x - nx * ball.r * 0.6;
    const cy = ball.y - ny * ball.r * 0.6;
    const dmg = this.flip.active ? FLIP.damage : 1;

    if (brick.kind === KIND.SHIELD && !this.flip.active && dmg < 2) {
      // Bounce off the shield with an annoying metal ping.
      brick.flash = 1; brick.wob = 1;
      this.audio?.shield((ball.x - FIELD.x) / FIELD.w * 2 - 1, 1);
      this.fx.shake(0.14, nx, ny);
      this.particles.burst(cx, cy, { count: 12, speed: [90, 300], color: COLORS.shield, life: 0.35, size: 2.4, glow: 1 });
      this.particles.ring(cx, cy, COLORS.shield, 8, 44, 0.3, 2.5, 0.8);
      this._popup(cx, cy - 14, 'SHIELD', COLORS.shield, 14, 0.6);
      ball.squash = 0.4;
      return;
    }

    const res = this.level.hit(brick, dmg, this);
    if (res === 'damaged') {
      this.audio?.brick(Math.min(3, this.chain), (ball.x - FIELD.x) / FIELD.w * 2 - 1, 'armored');
      this.fx.shake(JUICE.shakeArmored, nx, ny);
      this.fx.freeze(0.012);
      this.particles.burst(cx, cy, { count: 14, speed: [90, 340], color: brick.color, life: 0.4, size: 3, glow: 0.6 });
      this.particles.shards(cx, cy, brick.w, brick.h, brick.color, 5);
      ball.squash = 0.45;
      this.addScore(40, cx, cy, null);
      return;
    }

    // ------- destroyed
    this._destroyBrick(brick, cx, cy, nx, ny, speed, ball);
  }

  _destroyBrick(brick, cx, cy, nx, ny, speed, ball) {
    const pan = (cx - FIELD.x) / FIELD.w * 2 - 1;
    this.level.kill(brick, this);
    this.bricksBroken++;
    this.chain++;
    this.chainTimer = COMBO.timeout;
    const mult = this._chainMultiplier();
    const isNewMultiplier = mult > this.multiplier;
    this.multiplier = mult;

    this.audio?.brick(this.chain - 1, pan, brick.kind === KIND.ARMORED ? 'armored' : 'basic');
    if (this.chain > 1 && this.chain % COMBO.perMultiplier === 0) this.audio?.combo(this.chain / COMBO.perMultiplier);

    // Particles: shrapnel + sparks + a light puff, scaled by what was hit.
    const big = brick.kind !== KIND.NORMAL;
    this.particles.shards(cx, cy, brick.w, brick.h, brick.color, big ? 14 : 9);
    this.particles.burst(cx, cy, {
      count: big ? 22 : 14, speed: [140, 520], color: brick.color,
      life: 0.5, size: 3.2, glow: 1, jitter: 6,
    });
    this.particles.puff(cx, cy, brick.color, brick.w * 0.5, 0.42, { alpha: 0.5, glow: 1 });
    this.particles.ring(cx, cy, brick.color, 6, big ? 90 : 60, 0.34, big ? 4 : 2.5, 0.75);
    this.fx.addGlow(cx, cy, big ? 90 : 60, brick.color, 0.9);

    this.fx.shake(big ? JUICE.shakeBomb * 0.7 : JUICE.shakeBrick);
    this.fx.freeze(big ? 0.045 : JUICE.hitstopBrick);
    this.fx.punch(big ? 0.008 : 0.004);

    const base = SCORING.brick[brick.kind === KIND.ARMORED ? 'armored' : brick.kind === KIND.BOMB ? 'bomb' : brick.kind === KIND.SHIELD ? 'shield' : 'basic'];
    const points = base * this.multiplier;
    this.addScore(points, cx, cy, null);

    if (isNewMultiplier) {
      this._popup(cx, cy - 26, `x${mult}`, COLORS.gold, 26, 1.1);
      this.fx.flashScreen(COLORS.gold, 0.12);
      this.audio?.powerup('points', pan * 0.4);
      this.particles.ring(cx, cy, COLORS.gold, 10, 180, 0.5, 3, 0.7);
    } else if (this.multiplier > 1) {
      this._popup(cx, cy - 18, `${points}`, mixHex(COLORS.gold, brick.color, 0.5), 17, 0.7);
    }

    this.audio?.setIntensity(clamp(this.chain / 18, 0, 1));

    if (brick.kind === KIND.BOMB) {
      this._explode(cx, cy, 168);
    } else if (this.rng() < DROPS.chance || brick.kind === KIND.ARMORED && this.rng() < 0.3) {
      this._spawnDrop(cx, cy);
    }
  }

  _explode(x, y, radius) {
    this.audio?.explode((x - FIELD.x) / FIELD.w * 2 - 1);
    this.fx.shake(JUICE.shakeBomb);
    this.fx.freeze(JUICE.hitstopBomb);
    this.fx.flashScreen(COLORS.bombCore, JUICE.flashBomb);
    this.fx.chroma(1);
    this.fx.punch(0.02);
    this.particles.ring(x, y, COLORS.bombCore, 20, radius * 2.2, 0.55, 6, 0.95);
    this.particles.ring(x, y, '#ffffff', 8, radius * 1.3, 0.32, 4, 1);
    this.particles.burst(x, y, { count: 46, speed: [260, 1100], color: COLORS.bombCore, life: 0.7, size: 3.6, glow: 1, drag: 2.2, jitter: 10 });
    this.particles.burst(x, y, { count: 26, speed: [80, 420], color: COLORS.bomb, life: 0.9, size: 5, glow: 0.4, drag: 1.1, jitter: 16 });
    for (let i = 0; i < 8; i++) {
      this.particles.puff(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 60,
        i % 2 ? COLORS.bomb : COLORS.bombCore, 26, 0.7, { alpha: 0.45, glow: 1, vx: (Math.random() - 0.5) * 160, vy: (Math.random() - 0.5) * 160 });
    }
    this.fx.addGlow(x, y, radius * 1.8, COLORS.bombCore, 1);
    this.fx.addGlow(x, y, radius * 3, COLORS.bomb, 0.6);

    // Chain reaction: everything in range is queued with a small delay so the
    // destruction ripples outward instead of popping all at once.
    this.level.forEachInBox(x - radius, y - radius, x + radius, y + radius, (br) => {
      const d = Math.hypot(br.x + br.w / 2 - x, br.y + br.h / 2 - y);
      if (d <= radius) this._queueBlast(br, x, y, d / radius);
    });
    this._popup(x, y - 30, 'BOOM', COLORS.bomb, 30, 0.9);
  }

  _queueBlast(brick, sx, sy, k) {
    this.pendingBlasts.push({ brick, delay: 0.02 + k * 0.13, sx, sy });
  }

  _updateBlasts(dt) {
    for (let i = this.pendingBlasts.length - 1; i >= 0; i--) {
      const p = this.pendingBlasts[i];
      p.delay -= dt;
      if (p.delay > 0) continue;
      this.pendingBlasts.splice(i, 1);
      if (!p.brick.alive) continue;
      const cx = p.brick.x + p.brick.w / 2, cy = p.brick.y + p.brick.h / 2;
      if (p.brick.kind === KIND.BOMB) {
        this._destroyBrick(p.brick, cx, cy, 0, -1, 600, this.main);
      } else {
        this.level.kill(p.brick, this);
        this.bricksBroken++;
        this.chain++;
        this.chainTimer = COMBO.timeout;
        this.multiplier = this._chainMultiplier();
        this.particles.shards(cx, cy, p.brick.w, p.brick.h, p.brick.color, 8);
        this.particles.burst(cx, cy, { count: 12, speed: [120, 420], color: COLORS.bombCore, life: 0.45, size: 3, glow: 1 });
        this.addScore(SCORING.brick.basic * this.multiplier, cx, cy, null);
        this.fx.addGlow(cx, cy, 70, COLORS.bombCore, 0.7);
      }
    }
  }

  /** Landing a hit right after a long air chain pays a bonus. */
  _returnBonus() {
    if (this.chain >= 4) {
      const bonus = this.chain * SCORING.airChain;
      this.addScore(bonus, this.paddle.x, this.paddle.top - 40, `AIR x${this.chain} +${bonus}`, COLORS.accent, 18);
      this.fx.flashScreen(COLORS.accent, 0.12);
      this.audio?.combo(8);
      this.particles.ring(this.paddle.x, this.paddle.top, COLORS.accent, 10, 220, 0.5, 3, 0.8);
    }
    this._resetChain();
  }

  _resetChain() {
    if (this.chain >= 6) this._popup(this.paddle.x, this.paddle.top - 60, 'CHAIN END', COLORS.dim, 14, 0.6);
    this.chain = 0;
    this.multiplier = 1;
    this.audio?.setIntensity(0);
  }

  _chainMultiplier() {
    return clamp(1 + Math.floor(this.chain / COMBO.perMultiplier), 1, COMBO.max);
  }

  // ================================================================== score ===

  addScore(points, x, y, label, color = COLORS.gold, size = 16) {
    this.score += points;
    if (label) this._popup(x, y, label, color, size, 1.2);
    const tier = Math.floor(this.score / SCORING.extraLife);
    if (tier > this.livesAwarded) {
      this.livesAwarded = tier;
      this.lives++;
      this.audio?.extraLife();
      this.fx.flashScreen(COLORS.gold, 0.3);
      this._popup(FIELD.x + FIELD.w / 2, 200, 'EXTRA BALL', COLORS.gold, 32, 1.6);
      this.particles.burst(FIELD.x + FIELD.w / 2, 200, { count: 40, speed: [200, 620], color: COLORS.gold, life: 0.9, size: 3.4, glow: 1 });
      this._emit('extraLife');
    }
  }

  _popup(x, y, text, color, size = 16, life = 0.9) {
    if (this.popups.length > 26) this.popups.shift();
    this.popups.push({ x, y, text, color, size, life: 0, maxLife: life, vy: -70, grav: 34 });
  }

  // =================================================================== drops ===

  _spawnDrop(x, y) {
    const kinds = DROPS.kinds;
    const kind = kinds[(this.rng() * kinds.length) | 0];
    this.drops.push({ x, y, kind, t: 0, vy: DROPS.speed, w: 30, h: 30, wob: this.rng() * TAU });
  }

  _updateDrops(dt) {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.t += dt;
      d.y += d.vy * dt;
      d.x += Math.sin(d.t * 3 + d.wob) * 24 * dt;
      const pb = this.paddle;
      if (d.y + d.h / 2 > pb.y - pb.h / 2 && d.y - d.h / 2 < pb.y + pb.h / 2
        && d.x > pb.x - pb.w / 2 - 6 && d.x < pb.x + pb.w / 2 + 6) {
        this._applyDrop(d);
        this.drops.splice(i, 1);
        continue;
      }
      if (d.y - d.h > FIELD.bottom) {
        this.drops.splice(i, 1);
        continue;
      }
      this.fx.addGlow(d.x, d.y, 34, DROP_COLOR[d.kind], 0.6);
    }
  }

  _applyDrop(d) {
    const pan = (d.x - FIELD.x) / FIELD.w * 2 - 1;
    this.audio?.powerup(d.kind, pan);
    this.fx.flashScreen(DROP_COLOR[d.kind], 0.16);
    this.fx.shake(0.18);
    this.particles.ring(d.x, d.y, DROP_COLOR[d.kind], 8, 70, 0.4, 3, 0.9);
    this.particles.burst(d.x, d.y, { count: 20, speed: [100, 380], color: DROP_COLOR[d.kind], life: 0.5, size: 3, glow: 1 });
    this.paddle.onHit(0.5);

    switch (d.kind) {
      case 'wide':
        this.paddle.resize('wide');
        this.buffs.wide = DROPS.duration.wide;
        this._popup(d.x, d.y - 20, 'WIDE PADDLE', DROP_COLOR.wide, 18, 1.1);
        break;
      case 'multi': {
        const src = this.main;
        const speed = Math.max(this.ballSpeed(), Math.hypot(src.vx, src.vy));
        for (const a of [-0.45, 0.45]) {
          const nb = new Ball();
          nb.reset(src.x, src.y);
          nb.stuck = false;
          nb.vx = src.vx * Math.cos(a) - src.vy * Math.sin(a);
          nb.vy = src.vx * Math.sin(a) + src.vy * Math.cos(a);
          if (Math.hypot(nb.vx, nb.vy) < 1) { nb.vx = Math.cos(a) * speed; nb.vy = -Math.abs(Math.sin(a) * speed); }
          this.balls.push(nb);
        }
        this._popup(d.x, d.y - 20, 'MULTIBALL', DROP_COLOR.multi, 20, 1.1);
        break;
      }
      case 'slow':
        this._scaleSpeeds(0.72);
        this.buffs.slow = DROPS.duration.slow;
        this._popup(d.x, d.y - 20, 'SLOW MOTION', DROP_COLOR.slow, 18, 1.1);
        break;
      case 'grav':
        this.flip.charge = 1;
        this.flip.buff = DROPS.duration.grav;
        this._popup(d.x, d.y - 20, 'FLIP CHARGED', DROP_COLOR.grav, 18, 1.1);
        break;
      default:
        this.addScore(1200 * this.multiplier, d.x, d.y - 20, `+${1200 * this.multiplier}`, DROP_COLOR.points, 20);
        break;
    }
    this._emit('powerup', d.kind);
  }

  _killBall(b, index) {
    this.balls.splice(index, 1);
    // Shredded in the pit.
    this.audio?.wall(700, (b.x - FIELD.x) / FIELD.w * 2 - 1);
    this.fx.shake(0.4);
    this.fx.flashScreen(COLORS.pit, 0.25);
    this.fx.chroma(0.7);
    this.particles.burst(b.x, FIELD.bottom - 6, {
      count: 26, speed: [180, 620], color: COLORS.pit, life: 0.6, size: 3.4, glow: 1,
      angle: -Math.PI / 2, spread: 2.4,
    });
    this.particles.ring(b.x, FIELD.bottom - 6, COLORS.pit, 8, 160, 0.4, 4, 0.9);
    this.particles.shards(b.x, FIELD.bottom - 6, 22, 22, COLORS.ballHue, 8);
    if (this.balls.length > 0) {
      // Multiball: losing one ball just means fewer balls in play.
      this._popup(b.x, FIELD.bottom - 60, 'BALL LOST', COLORS.pit, 18, 0.9);
    }
  }

  _onLevelCleared() {
    this._setState(STATE.CLEAR);
    this.level.clearing = true;
    this.level.cleared = 0;
    this.audio?.clear();
    this.fx.shake(JUICE.shakeClear);
    this.fx.freeze(JUICE.hitstopLevel);
    this.fx.slowmo(0.55, 0.8);
    this.fx.flashScreen('#ffffff', 0.3);
    this._emit('levelClear', this.levelIndex);
    // Fireworks from each row of the arena.
    for (let i = 0; i < 6; i++) {
      const x = FIELD.x + 80 + this.rng() * (FIELD.w - 160);
      const y = FIELD.y + 120 + this.rng() * 300;
      const color = this.level.palette[(this.rng() * this.level.palette.length) | 0];
      this.particles.ring(x, y, color, 10, 220, 0.6, 4, 0.9);
      this.particles.burst(x, y, { count: 34, speed: [200, 700], color, life: 0.9, size: 3.4, glow: 1, drag: 1.6 });
      this.fx.addGlow(x, y, 120, color, 0.8);
    }
    // Unused bricks' colours rain down as confetti.
    for (const b of this.level.bricks) {
      if (!b.alive) continue;
      this.particles.shards(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, b.color, 3);
    }
  }

  _emit(name, data) { if (this.onEvent) this.onEvent(name, data); }

  // =================================================================== draw ===

  draw(r) {
    const t = this.t;
    const fx = this.fx;

    // --- brick field ---------------------------------------------------
    this.level.draw(r, this.state);

    // --- drops ---------------------------------------------------------
    for (const d of this.drops) {
      const color = DROP_COLOR[d.kind];
      const pulse = 0.5 + 0.5 * Math.sin(t * 8 + d.wob);
      r.halo(d.x, d.y, 30, color, 0.35 + pulse * 0.15);
      r.rect(d.x - 15, d.y - 12, 30, 24, { fill: mixHex(color, '#000000', 0.55), radius: 12 });
      r.rect(d.x - 13, d.y - 10, 26, 20, { fill: color, radius: 10, alpha: 0.9 });
      r.text(DROP_LABEL[d.kind], d.x, d.y + 1, {
        size: 15, weight: 900, color: '#04060c', align: 'center', baseline: 'middle', mono: true,
      });
    }

    // --- balls ---------------------------------------------------------
    for (const b of this.balls) {
      if (b.dead) continue;
      drawBall(r, b, t, this.flip.active);
    }

    // --- paddle --------------------------------------------------------
    const danger = this._danger();
    this.paddle.draw(r, t, danger);
    if (this.main && this.main.stuck && (this.state === STATE.READY)) {
      this.paddle.drawLaunchHint(r, t, this.main);
    }

    // --- popups (world space, drawn on top of the action) ---------------
    for (const p of this.popups) {
      const k = p.life / p.maxLife;
      const a = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      const pop = k < 0.2 ? 1 + (0.2 - k) * 2.2 : 1;
      r.text(p.text, p.x, p.y, {
        size: p.size * pop, weight: 900, color: p.color, align: 'center', baseline: 'middle',
        alpha: clamp(a, 0, 1), glow: true, glowColor: p.color, glowWidth: p.size * 0.5,
      });
    }

    // --- gravity flip overlay telegraph ---------------------------------
    if (this.flip.active) {
      // A wash strong enough to read as "gravity is broken", weak enough that
      // the bricks and the ball stay legible: it grows as the window expires.
      const k = 1 - this.flip.t / FLIP.duration;
      r.rect(FIELD.x, FIELD.y, FIELD.w, FIELD.h, {
        fill: rgba(COLORS.flip, 0.018 + k * 0.03 + 0.012 * Math.sin(t * 14)),
      });
      // upward speed lines (the world is falling the wrong way)
      const lineA = 0.10 + 0.16 * Math.sin(Math.PI * Math.min(1, k * 3));
      for (let i = 0; i < 16; i++) {
        const x = FIELD.x + ((i * 71 + (t * 900) % 71) % FIELD.w);
        const y = FIELD.bottom - ((t * 1400 + i * 137) % FIELD.h);
        r.line(x, y, x, y - 70, { color: rgba(COLORS.flip, lineA), lw: 2 });
      }
      // walls glow at both ends: the anti-gravity field is a sandwich
      const bar = 0.35 + 0.25 * Math.sin(t * 18);
      r.rect(FIELD.x, FIELD.y, FIELD.w, 5, { fill: rgba('#e6d9ff', bar) });
      r.rect(FIELD.x, FIELD.bottom - 5, FIELD.w, 5, { fill: rgba(COLORS.flip, 0.3 + 0.2 * Math.sin(t * 18 + 1)) });
    }
  }

  _danger() {
    let d = 0;
    for (const b of this.balls) {
      if (b.dead) continue;
      const k = (b.y - this.paddle.y) / (FIELD.bottom - this.paddle.y - b.r);
      d = Math.max(d, clamp(k, 0, 1));
    }
    return d;
  }
}

// ---------------------------------------------------------------- rendering ---

function drawBall(r, b, t, flipped) {
  const speed = Math.hypot(b.vx, b.vy);
  const stretch = clamp(speed / BALL.speedMax, 0, 1) * BALL.squash + b.squash * 0.5;
  const rot = speed > 30 ? Math.atan2(b.vy, b.vx) : 0;
  const hue = flipped ? COLORS.flip : COLORS.ballHue;

  // trail (oldest -> newest, tapering)
  const n = b.trailLen;
  const ctx = r.ctx;
  if (n > 2) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 1; i < n; i++) {
      const idx = (b.trailHead - n + i + TRAIL_N * 2) % TRAIL_N;
      const prev = (b.trailHead - n + i - 1 + TRAIL_N * 2) % TRAIL_N;
      const k = i / n;
      const alpha = k * k * 0.5;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = k > 0.65 ? '#ffffff' : hue;
      ctx.lineWidth = b.r * 1.5 * k;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(b.trailX[prev], b.trailY[prev]);
      ctx.lineTo(b.trailX[idx], b.trailY[idx]);
      ctx.stroke();
    }
    ctx.restore();
  }

  r.halo(b.x, b.y, b.r * (flipped ? 7 : 5.5), hue, 0.5 + b.flash * 0.4, 0.12);
  if (b.flash > 0.01) r.halo(b.x, b.y, b.r * 4, '#ffffff', b.flash * 0.5, 0.1);

  const ctx2 = r.ctx;
  ctx2.save();
  ctx2.translate(b.x, b.y);
  if (rot) ctx2.rotate(rot);
  const rx = b.r * (1 + stretch * 0.55);
  const ry = b.r * (1 - stretch * 0.4);
  // body
  ctx2.beginPath();
  ctx2.arc(0, 0, rx, 0, TAU);
  const g = ctx2.createRadialGradient(-rx * 0.3, -ry * 0.35, rx * 0.1, 0, 0, rx);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.45, mixHex(COLORS.ball, hue, 0.35));
  g.addColorStop(1, flipped ? '#7b46ff' : '#0f6f9a');
  ctx2.scale(1, ry / rx);
  ctx2.fillStyle = g;
  ctx2.fill();
  ctx2.restore();

  // rim + core highlight, unrotated so the sparkle always reads
  r.circle(b.x, b.y, b.r, { stroke: rgba('#ffffff', 0.35 + b.flash * 0.4), lw: 1.2 });
  // Spinning sparkle so the ball reads as a *thing*, not a dot, at any speed.
  const s = b.spin;
  const sl = b.r * 0.52;
  r.poly([
    [b.x + Math.cos(s) * sl, b.y + Math.sin(s) * sl],
    [b.x + Math.cos(s + Math.PI / 2) * sl * 0.3, b.y + Math.sin(s + Math.PI / 2) * sl * 0.3],
    [b.x + Math.cos(s + Math.PI) * sl, b.y + Math.sin(s + Math.PI) * sl],
    [b.x + Math.cos(s - Math.PI / 2) * sl * 0.3, b.y + Math.sin(s - Math.PI / 2) * sl * 0.3],
  ], { fill: 'rgba(255,255,255,0.85)' });
  r.circle(b.x - b.r * 0.28, b.y - b.r * 0.32, b.r * 0.22, { fill: 'rgba(255,255,255,0.95)' });
}
