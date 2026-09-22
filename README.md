# GRAVITY BALL

A juiced-up arcade breakout: real gravity on the ball, a gravity-flip super move, chain
multipliers, screen shake, hitstop, chromatic fringes, procedural explosions and a
procedurally synthesized soundtrack.

**Zero dependencies. No build step. No asset files.** Three static files and a canvas.

```
npm start          # serve on http://localhost:8080
npm test           # syntax check + 84 headless gameplay assertions
```

---

## How to check it

Three tiers, cheapest first.

**1. Play it.** `npm start`, then open `http://localhost:8080`. There is no build step —
the browser loads `src/main.js` directly as an ES module. Move with the mouse, press
`Space` (or right-click) to flip gravity. If you only do one check, do this one: the whole
point of the project is how it *feels*, and no assertion can tell you that.

**2. Run the test suite.** `npm test` — parses every module, then drives the **real `World`
instance** through 84 assertions covering bomb chain reactions, shield bricks vs
anti-gravity, each power-up, combo expiry, extra balls, last-life death, restart, level
progression, pause, letterbox maths at 2560×1440, drag-vs-tap on touch, the on-screen flip
pad, and a 90-second physics soak with deliberately erratic steering that asserts the ball
never leaves the arena and the speed cap holds.

```
✓ 17 modules parsed cleanly
84 passed, 0 failed
```

**3. Watch the autopilot.** `npm run shots` plays ~150 simulated seconds unattended and
writes screenshots of the key moments to `out/shots/`; `npm run simulate` does the same run
without writing images. Useful for eyeballing the juice — bombs, flips, level clears —
without playing for it.

> **Reading the headless screenshots:** the software canvas in `tools/canvas-mock.mjs` has
> no font rasterizer, so it draws each glyph as a rough blocky "ink" pattern. Text in
> `out/` PNGs is therefore unreadable — that is the mock, not the game. In a real browser
> the canvas uses the actual system font and the typography is crisp. Judge layout,
> colour, glow and particle work from the screenshots; judge text by playing.

---

## The hook

Breakout, but the ball has weight. It arcs, it hangs, it dives early — you have to *lead*
your shots instead of watching a straight line bounce around.

The escape hatch is the **gravity flip**: for ~1 second gravity inverts, the ball rockets
into the ceiling, and **everything it touches takes double damage**. It is a save move, a
combo starter and the only way to break the shield bricks, and it recharges in about two
seconds so you are constantly deciding whether to spend it.

## Controls

| | |
|---|---|
| Move | Mouse · touch drag · `←` `→` |
| Launch / flip / start / retry | Click · tap · `Space` |
| Flip (touch) | the on-screen **GRAVITY** pad, or a tap that isn't a drag |
| Pause · mute · restart · debug | `P` / `Esc` · `M` · `R` · `F1` |
| Cycle feel preset | `F3` (or the FEEL row on the title screen) |

Desktop is pointer-based (right-click also flips, in case you are playing one-handed and
hate keyboards). On touch, a *drag* only steers the paddle and a *tap* flips, so you never
flip by accident while repositioning.

## Rules of the arena

* Clear every brick to advance. 5 hand-built levels teach the mechanics, then seeded
  procedural layouts take over with mirrored patterns, armoured bricks and more bombs.
* Chain bricks without touching the paddle to raise the multiplier (2 bricks per step, up
  to **x16**) — the pitch of the break sound climbs the pentatonic ladder with your chain,
  and the soundtrack's filter opens up as you get hot.
* Landing a hit after an airborne chain of 4+ pays an **air-chain bonus**.
* Brick types: **plain** (multi-row colours), **armoured** (3–4 hits, cracks as it dies),
  **bomb** (detonates a chain reaction through its neighbours), **shield** (immune to
  normal hits — only anti-gravity gets through).
* Power-ups drop from broken bricks: `W` wide paddle, `M` multiball, `S` slow-motion,
  `G` instant flip recharge, `$` score.
* No bottom wall. The floor is a shredder; every ball lost is a life. Extra ball every
  20 000 points.

## What makes it feel good (the "juice" checklist)

| Technique | Where |
|---|---|
| Screen shake with a **trauma model** (amplitude = trauma², decays over time) | `core/fx.js` |
| **Hitstop** — the sim freezes for 12–110 ms on impact, scaled by what was hit | `core/fx.js`, `world.js` |
| **Slow-motion** ramp on gravity flips and deaths | `core/fx.js` |
| **Squash & stretch** on the ball, paddle and brick pop-in | `world.js`, `paddle.js`, `level.js` |
| Directional camera **kick** (impacts shove the camera away from the hit) | `fx.shake(amount, dirX, dirY)` |
| **Additive glow** halos instead of a blur pass — overlapping halos accumulate into real bloom | `render/renderer.js` |
| Screen **flash**, **chromatic fringes**, scanlines, grain, vignette | `main.js` post-processing |
| Pooled particles: shrapnel, sparks, shockwaves, smoke, embers, anti-gravity wind | `core/particles.js` |
| **Procedural audio** — every sound synthesized from oscillators + one noise buffer | `core/audio.js` |
| Score pop-ups, banner type, wave-animated logo, pips for lives | `render/hud.js` |
| A **FEEL** preset selector on the title screen, so the tuning is playable rather than argued about | `config.js`, `render/hud.js` |
| Ball trail, paddle heat trail, animated hazard chevrons that speed up as the ball falls | `world.js`, `bg.js` |

## Physics notes

* **Fixed 1/120 s simulation steps** inside a variable-rate render loop, with a spiral-of-
  death guard (`config.TIMING.maxFrame`).
* **Continuous collision detection**: the ball is swept as a circle against AABBs using the
  Minkowski slab test (`math.sweepCircleBox`). It returns the exact time of impact, so a
  1400 px/s ball cannot tunnel through a 6 px gap, and it is cheaper than sub-stepping.
  Brick candidates come from a uniform grid, so a step tests a handful of cells.
* **Gravity is integrated, but the response is authored**: flips apply a deceleration
  proportional to current speed (so the move always reads), paddle bounces are reflected
  *and* aimed, min/max speed clamps are re-applied after every collision, and a watchdog
  nudges a near-horizontal ball so the game can never deadlock.
* The paddle uses an **exponential chase** (`1 - e^(-λt)`) rather than a speed, which reads
  as weight without input lag; its own velocity is added into the bounce ("english"), so
  flicking the paddle slingshots the ball.


## Feel presets

Game feel is a search problem, so the search space is a runtime setting instead of a
constant. `F3` (or the **FEEL** row on the title screen) rotates between three tunings, and
the choice persists in `localStorage`.

| | FLOATY | ARCADE | FRANTIC |
|---|---|---|---|
| Gravity | 300 px/s² | 420 | 620 |
| Launch speed | 520 | 600 | 720 |
| Speed per level | +14 | +22 | +32 |
| Paddle width | 168 px | 130 | 108 |
| Flip duration / cooldown | 1.35 s / 0.85 s | 1.05 s / 1.15 s | 0.85 s / 1.45 s |
| Chain window | 4.5 s | 3.5 s | 2.6 s |
| Drop chance | 14% | 11% | 9% |
| Shake ceiling | 20 px | 30 px | 38 px |

**ARCADE is the authored tuning** — it is what the numbers in `config.js` already were, so
the default experience is unchanged. The other two are different *reads* of the same rules
rather than difficulty levels bolted on afterwards: FLOATY lowers gravity so the ball hangs
and you can lead shots instead of reacting; FRANTIC makes it dive early and takes away the
generous paddle, so every save is earned.

Implementation notes, because the obvious version of this is a bug factory:

* A preset only ever touches **feel** numbers — never geometry. Brick layout (`GRID`), the
  playfield and the ball radius are level design, and `GRID` carries derived values
  (`pitchX`/`pitchY`) computed once at load. Keeping presets off them means a preset can
  never desync the layout from the physics.
* Each preset is a **partial override over a `BASELINE` snapshot**, and applying a preset
  restores the baseline first. That is what makes switching idempotent: applying `frantic`
  twice cannot stack, and `floaty → arcade` fully undoes `floaty` instead of leaving
  residue behind. An unknown name is refused outright rather than half-applied.
* `speedMax` is deliberately **identical in all three**. It is the cap that keeps the
  continuous collision detection honest — a physics constraint, not a difficulty knob.
* Swapping presets **does not rescale the ball in flight**. Balls keep their velocity on
  purpose: teleporting a ball mid-rally would read as a bug, and the per-collision min/max
  clamps walk the speed into the new range within a bounce or two.
* A preset swap **preserves an active wide power-up** rather than silently cancelling it —
  the paddle remembers whether it is wide (`paddle.wide`) instead of inferring it from its
  current width.

## Architecture

```
index.html            markup + fallback text
src/styles.css        framing only (the canvas does the visuals)
src/config.js         EVERY tunable number, commented  ← start here
src/main.js           bootstrap, game loop, post-processing, localStorage
src/core/
  math.js             easing, seeded RNG, colour math, swept-circle-vs-AABB
  input.js            one model for mouse + touch + keyboard, drag-vs-tap resolution
  particles.js        fixed-size pool, 5 particle flavours, additive emission
  fx.js               trauma/shake, hitstop, slow-mo, flashes, bloom queue
  audio.js            WebAudio synthesis: instruments, SFX, adaptive music
src/game/
  world.js            the simulation: ball, collisions, scoring, flips, power-ups, flow
  level.js            hand-authored + procedural brick layouts, damage, rendering
  paddle.js           chase, squash & stretch, aimed reflection
src/render/
  renderer.js         virtual-resolution canvas, glow primitives, CRT post-processing
  bg.js               parallax starfield, grid, gravity telegraphs, shredder pit
  hud.js              score band, flip meter, banners, title/clear/game-over/pause screens
tools/                headless test rig (see below)
```

The game is authored in a fixed **1000×760 virtual resolution** and letterboxed with DPR
scaling, so every physics constant is resolution-independent and the pointer mapping is
exact at any window size. Portrait windows get a "rotate your device" message (the arena
is wide by design) while staying playable behind it.

## Testing without a browser

The sandbox this project was built in has no browser and no way to install one, so the
test rig implements a **software Canvas2D** (`tools/canvas-mock.mjs`) that rasterizes the
game's draw calls in JavaScript and writes PNGs. That makes the real game runnable and
*screenshot-able* headlessly, and it audits the game's canvas usage at the same time:

* any absent context property throws (catching API drift),
* unsupported features (`clip`, `drawImage`, per-frame filters) are reported as warnings,
* **invalid CSS colours are recorded and rendered magenta** — in a real browser an invalid
  `fillStyle` is silently ignored and keeps the previous colour, which is a genuinely
  nasty class of bug. (This exact bug existed in `mixHex(mixHex(...))` chains and was
  found by the harness.)

```
node tools/lint.mjs              # parse every module
node tools/scenarios.mjs         # 84 assertions + 22 screenshots in out/scenarios/
node tools/harness.mjs --seconds 150   # autopilot plays the game, screenshots key moments
```

`scenarios.mjs` drives the live `World` instance: bomb chain reactions, shield bricks vs
anti-gravity, every power-up, combo expiry, extra balls, last-life death, restart, level
progression, pause, letterbox/DPR maths at 2560×1440, drag-vs-tap on touch, the on-screen
flip pad, portrait layout — plus a **90-second physics soak** that plays with deliberately
erratic steering and asserts the ball never leaves the arena and the speed cap holds.

The presets get their own 20 assertions, including the two that matter most: that
switching `floaty → arcade → frantic` cannot stack, and that a preset swap never touches
brick geometry. It also replays **20 seconds of FRANTIC** — the heaviest tuning — through
the same escape-and-speed-cap soak, and runs last, since a preset mutates the shared config
object that every other scenario asserts against.

## Accessibility & settings

* `prefers-reduced-motion` is respected (shake and flash are damped in `main.js`).
* `F2` toggles screen shake, `M` mutes; both persist in `localStorage`, as does the best
  score and the chosen feel preset. The bottom band is a reserved touch strip, so no button ever sits under your
  finger mid-rally.
* The canvas carries a descriptive `aria-label` and the page has a text summary of the
  controls for screen readers; audio is fully optional and never required to play.

## License

MIT — do what you like with it.
