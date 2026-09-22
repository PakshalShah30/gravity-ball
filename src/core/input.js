/**
 * input.js — one input model for mouse, touch and keyboard.
 *
 * The game only ever sees *virtual* coordinates and four intent flags, which
 * keeps the gameplay code free of browser quirks. Screen -> virtual mapping is
 * injected by the renderer so this file needs to know nothing about layout.
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;

    // Virtual-space pointer position (the paddle follows this).
    this.x = 500;
    this.y = 640;
    this.pointerDown = false;
    this.hasPointer = false;
    this.isTouch = false;
    this.touchGrab = 0;   // relative-drag offset, decays back to 0

    // Edge-triggered intents, cleared by endFrame().
    this.primary = false;        // click / tap / space: launch, flip, start, retry
    this.gravityButton = false;  // the on-screen GRAVITY pad (touch only)
    this.pause = false;
    this.mute = false;
    this.restart = false;
    this.debug = false;
    this.toggleShake = false;

    this.axis = 0;        // -1..1 keyboard steering
    this.keys = new Set();
    this.clock = 0;
    this.downX = 0;
    this.downY = 0;
    this.downT = 0;

    // main.js installs a hit-test so on-screen buttons (the touch GRAVITY pad)
    // can swallow a tap instead of moving the paddle.
    this.hitTest = null;
    this.toVirtual = (cx, cy) => ({ x: cx, y: cy });
    this.onFirstInput = null;

    this._bind();
  }

  _bind() {
    const c = this.canvas;
    const move = (e) => {
      const p = this.toVirtual(e.clientX, e.clientY);
      this.x = p.x;
      this.y = p.y;
      this.hasPointer = true;
      this.isTouch = e.pointerType === 'touch';
      if (this.isTouch && this.touchGrabSet) {
        // Relative dragging: the paddle keeps its offset from the finger.
        this.touchGrab = this.grabStart + (this.x - this.grabOriginX);
        this.touchGrab = Math.max(-140, Math.min(140, this.touchGrab));
      }
    };

    c.addEventListener('pointermove', move, { passive: true });
    c.addEventListener('pointerdown', (e) => {
      const p = this.toVirtual(e.clientX, e.clientY);
      this.x = p.x; this.y = p.y;
      this.hasPointer = true;
      this.isTouch = e.pointerType === 'touch';
      this.pointerDown = true;
      this._fireFirst();

      // Remember where the gesture started: the primary action only fires on
      // *release* if the pointer did not really move. Otherwise dragging the
      // paddle would flip gravity every time the player let go.
      this.downX = this.x;
      this.downY = this.y;
      this.downT = this.clock;

      const action = this.hitTest ? this.hitTest(this.x, this.y, this.isTouch) : null;
      if (action === 'gravity') {
        // Dedicated flag: the on-screen pad only ever means "gravity flip".
        this.gravityButton = true;
        this.blockDrag = true;
        return;
      }
      if (e.pointerType === 'touch' && this.touchX === undefined) {
        // Only the first finger steers; extra fingers are taps.
        this.touchX = this.x;
        this.grabOriginX = this.x;
        this.grabStart = typeof this.onGrabX === 'function' ? this.onGrabX() : (this.onGrabX || 0);
        this.touchGrabSet = true;
        this.touchGrab = this.grabStart;
      }
      if (e.button === 2) this.primary = true;   // right click == gravity flip
      else this.primaryPending = true;            // resolved on pointerup (tap vs drag)
      c.setPointerCapture?.(e.pointerId);
    }, { passive: true });

    c.addEventListener('pointerup', (e) => {
      this.pointerDown = false;
      if (e.pointerType === 'touch') {
        this.touchX = undefined;
        this.touchGrabSet = false;
        this.touchGrab = 0;
      }
      // A tap that did not drag counts as "primary" (launch/flip). A drag is
      // just paddle movement.
      const moved = Math.hypot(this.x - (this.downX ?? this.x), this.y - (this.downY ?? this.y));
      if (this.primaryPending && !this.blockDrag && moved < 14) this.primary = true;
      this.primaryPending = false;
      this.blockDrag = false;
    }, { passive: true });

    c.addEventListener('pointercancel', () => {
      this.pointerDown = false;
      this.touchX = undefined;
      this.touchGrabSet = false;
      this.touchGrab = 0;
      this.primaryPending = false;
      this.blockDrag = false;
    }, { passive: true });

    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => { this.keys.clear(); this.axis = 0; this.pointerDown = false; });

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this._fireFirst();
      this.keys.add(e.code);
      switch (e.code) {
        case 'Space': case 'Enter': case 'ArrowUp': case 'KeyW': this.primary = true; break;
        case 'KeyP': case 'Escape': this.pause = true; break;
        case 'KeyM': this.mute = true; break;
        case 'KeyR': this.restart = true; break;
        case 'F1': this.debug = true; break;
        case 'F2': this.toggleShake = true; break;
        case 'ArrowLeft': case 'KeyA': case 'ArrowRight': case 'KeyD': e.preventDefault(); break;
      }
      if (e.code === 'Space') e.preventDefault();
    });

    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  _fireFirst() {
    if (this.onFirstInput) { this.onFirstInput(); this.onFirstInput = null; }
  }

  /** Keyboard steering, resolved once per frame. */
  update(dt) {
    this.clock += dt;
    const l = this.keys.has('ArrowLeft') || this.keys.has('KeyA');
    const r = this.keys.has('ArrowRight') || this.keys.has('KeyD');
    const want = (r ? 1 : 0) - (l ? 1 : 0);
    this.axis = want;
    // Mobile relative-drag offset self-centres so the paddle stays reachable.
    if (this.touchGrabSet) this.touchGrab *= Math.exp(-1.4 * dt);
  }

  endFrame() {
    this.primary = false;
    this.gravityButton = false;
    this.pause = false;
    this.mute = false;
    this.restart = false;
    this.debug = false;
    this.toggleShake = false;
  }
}
