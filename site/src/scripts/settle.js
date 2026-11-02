/* Frame settle, the beat track and the thread. ONE mechanism for "a frame locks in": CSS scroll-snap
 * is off on this page (crew.css), because Chromium's `proximity` captures anything within a third of
 * a frame, so slow wheel notches from a frame top were pulled straight back to it.
 *
 * Every user scroll ends on a frame top, in the direction of travel. When a gesture starts, the page
 * remembers where it was; when the scroll comes to rest:
 *  - a wheel or touch nudge under 12% of a frame (60px at most) from a frame top glides back to it,
 *    and nudges the same way add up, so a gentle scroller still moves on;
 *  - otherwise the page glides to the next frame top after the start, in the direction of travel;
 *  - a long fling that went past that frame ends on the frame top it passed last when it is within
 *    10% of a frame (an overshoot never accumulates), or on the next one ahead;
 *  - a key (PageDown/Up, Space) steps one frame per press; the arrows, one frame per burst;
 *  - the bottom of the page counts as a frame, so paging up from the end lands on Get it's top;
 *  - a burst of arrow keys ends on the frame ahead of where it scrolled to, never behind it;
 *  - new input during a glide stops the glide where it is; a keyboard focus stops it for good.
 * Every desktop frame is exactly one window tall, so nothing is ever skipped. It is off below 1024px
 * wide or 640px tall, under prefers-reduced-motion, while a section taller than its frame is in view,
 * and after a keyboard focus scrolled the page (Tab), so focus never jumps away. */

const reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const topbarH = () => { const b = document.querySelector('.topbar'); return b ? b.getBoundingClientRect().height : 64; };
const now = () => (window.performance ? performance.now() : Date.now());
const FRAMES = '[data-frame], .same-garden, .footer';

(function settle() {
  const NUDGE = 0.12, NUDGE_PX = 60, OVER = 0.10;
  const SCROLL_KEYS = ['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' '];
  // A gesture: the user inputs since the last rest. y0 = where it started; idir = the direction it
  // asked for (+1 down, -1 up, 0 unknown); keys = its scroll-key presses, signed (a PageDown and a
  // PageUp cancel out); jump = Home / End.
  // restY = where the page last came to rest. A gesture starts there, not at scrollY when its first
  // input event arrives: with threaded scrolling, a wheel notch has often moved the page already.
  let pending = false, y0 = window.scrollY, restY = window.scrollY, idir = 0, keys = 0, jump = false, arrows = false, keyed = false, touched = false;
  let gliding = false, glideTo = 0, focusAt = -1e9, inputAt = -1e9, restT = 0;
  // small nudges add up: two 30px nudges the same way from the same frame make one 60px move, so a
  // gentle scroller is never held on a frame, however slowly they go (reset by a turn or a new frame)
  const nudge = { dir: 0, sum: 0, frame: -1 };
  const on = () => window.innerWidth >= 1024 && window.innerHeight >= 640 && !reduceMQ.matches;
  const maxY = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  /** Stop our glide where it is: the browser's smooth scroll keeps going unless it is replaced. */
  function halt() {
    if (!gliding) return;
    gliding = false;
    window.scrollTo({ top: window.scrollY, behavior: 'instant' });
  }
  function begin(kind, dir) {
    const t = now();
    // an input that cannot move the page (down at the bottom, up at the top) starts nothing
    if (dir && !gliding && ((dir > 0 && window.scrollY >= maxY() - 1) || (dir < 0 && window.scrollY <= 0))) return;
    clearTimeout(restT);
    if (gliding) {
      // the visitor takes over our glide: it stops where it is, and the gesture counts from the
      // frame the glide was going to (so a reversal goes back, and another notch goes on)
      halt(); y0 = glideTo; idir = 0; keys = 0; jump = false; arrows = false; keyed = false; touched = false;
    } else if (!pending || t - inputAt > 600) {
      y0 = restY; idir = 0; keys = 0; jump = false; arrows = false; keyed = false; touched = false;
    } else if (kind === 'touch' && dir && idir && dir !== idir) {
      // a finger that turns back without lifting: the gesture starts again from where it turned
      y0 = window.scrollY; nudge.sum = 0;
    }
    pending = true;
    if (kind === 'key') { keys += dir; arrows = false; keyed = true; }
    else if (kind === 'arrow') { keys = dir; arrows = true; keyed = true; }   // the arrows: see target()
    else if (kind === 'jump') jump = true;
    else if (kind === 'wheel' || kind === 'touch') { keys = 0; keyed = false; if (kind === 'touch') touched = true; }
    if (dir) idir = dir;
    // an explicit scroll after a keyboard focus is the visitor's again: the focus guard ends
    if (kind !== 'pointer') focusAt = -1e9;
    inputAt = t;
  }
  // settling switched off mid-glide (reduced motion turned on, a window made too small): stop now
  function off() { if (on()) return; halt(); clearTimeout(restT); pending = false; restY = window.scrollY; }
  if (reduceMQ.addEventListener) reduceMQ.addEventListener('change', off);
  window.addEventListener('resize', off);
  window.addEventListener('wheel', (e) => { if (e.deltaY) begin('wheel', e.deltaY > 0 ? 1 : -1); }, { passive: true });
  // a finger moving up scrolls down: the direction is the finger's latest clear movement (4px or more)
  let touchY = null;
  window.addEventListener('touchstart', (e) => { touchY = e.touches && e.touches[0] ? e.touches[0].clientY : null; }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    const y = e.touches && e.touches[0] ? e.touches[0].clientY : null;
    const dy = touchY === null || y === null ? 0 : touchY - y;
    if (Math.abs(dy) > 4) { begin('touch', dy > 0 ? 1 : -1); touchY = y; } else begin('touch', 0);
  }, { passive: true });
  window.addEventListener('pointerdown', () => begin('pointer', 0), { passive: true });
  // a release keeps its gesture alive until the scroll comes to rest (a held key, a scrollbar drag)
  const release = () => { if (pending) inputAt = now(); };
  window.addEventListener('keyup', (e) => { if (SCROLL_KEYS.indexOf(e.key) >= 0) release(); });
  window.addEventListener('pointerup', release, { passive: true });
  window.addEventListener('touchend', release, { passive: true });
  // keyboard focus wins: a glide under way stops where it is, and nothing settles after it
  function focusTakes() { focusAt = now(); halt(); clearTimeout(restT); pending = false; }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { focusTakes(); return; }
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const tg = e.target;
    // Space on a control presses it; it does not scroll
    if (e.key === ' ' && tg && tg.closest && tg.closest('button, a, input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Home' || e.key === 'End') begin('jump', 0);
    else if (SCROLL_KEYS.indexOf(e.key) >= 0) begin(e.key.indexOf('Arrow') === 0 ? 'arrow' : 'key', (e.key === 'PageUp' || e.key === 'ArrowUp' || (e.key === ' ' && e.shiftKey)) ? -1 : 1);
  });
  // a keyboard focus that scrolled the page is left where it is (a mouse click focuses without :focus-visible)
  window.addEventListener('focusin', (e) => {
    const t = e.target;
    let kb = true;
    try { kb = !!(t && t.matches && t.matches(':focus-visible')); } catch (err) { kb = true; }
    if (kb) focusTakes();
  });

  function tops() {
    const tb = topbarH(), y = window.scrollY, max = maxY();
    const out = Array.prototype.slice.call(document.querySelectorAll(FRAMES))
      .map((el) => Math.min(max, Math.max(0, Math.round(el.getBoundingClientRect().top + y - tb))));
    out.push(max);
    out.sort((a, b) => a - b);
    return out.filter((v, k) => k === 0 || v - out[k - 1] > 2);
  }
  function tallInView() {
    const tb = topbarH(), vh = window.innerHeight - tb;
    return Array.prototype.slice.call(document.querySelectorAll(FRAMES)).some((el) => {
      const r = el.getBoundingClientRect();
      return r.height > vh + 2 && r.top < window.innerHeight - 1 && r.bottom > tb + 1;
    });
  }
  function target(y) {
    const vh = window.innerHeight - topbarH(), max = maxY();
    const T = tops();
    const d = y - y0;
    if (Math.abs(d) < 1) return null;
    // the direction asked for wins (a notch that interrupted a glide can rest short of where it began);
    // for keys it is the net of their presses
    const down = keys ? keys > 0 : (idir ? idir > 0 : d > 0), over = OVER * vh;
    const nearest = T.reduce((a, b) => (Math.abs(b - y0) < Math.abs(a - y0) ? b : a), T[0]);
    const onStart = Math.abs(nearest - y0) <= 2;
    const thr = Math.min(NUDGE * vh, NUDGE_PX);
    if (keyed && keys === 0) {                // keys that cancelled out: back where they began
      return onStart ? nearest : T.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a), T[0]);
    }
    if (keys) {
      // PageDown / PageUp / Space: one frame per press, counted from the frame the gesture started on
      let s;
      if (onStart) s = T.indexOf(nearest);
      else if (down) s = T.filter((v) => v < y0).length - 1;
      else s = T.length - T.filter((v) => v > y0).length;
      const to = T[Math.max(0, Math.min(T.length - 1, s + keys))];
      if (!arrows) return to;
      // the arrows scroll 40px a press natively: a burst can pass that frame, so it ends on the frame
      // ahead of where it got to, never behind it
      if (down) { const a = T.find((v) => v >= y - 2); return Math.max(to, a === undefined ? max : a); }
      const a = T.filter((v) => v <= y + 2).pop();
      return Math.min(to, a === undefined ? 0 : a);
    }
    if (onStart && Math.abs(d) < thr) {
      const sgn = d > 0 ? 1 : -1;
      if (nudge.dir === sgn && nudge.frame === nearest) nudge.sum += Math.abs(d); else { nudge.dir = sgn; nudge.sum = Math.abs(d); nudge.frame = nearest; }
      if (nudge.sum < thr) return nearest;      // a nudge: back to the frame it started on
      nudge.sum = 0;                            // nudges that add up to a move: step on
    } else nudge.sum = 0;
    if (down) {
      const next = T.find((v) => v > y0 + 2);
      if (next === undefined) return max;
      if (y <= next + over) return next;
      const passed = T.filter((v) => v <= y).pop();
      const ahd = T.find((v) => v > y);
      return ahd === undefined || y - passed <= over ? passed : ahd;
    }
    const prev = T.filter((v) => v < y0 - 2).pop();
    if (prev === undefined) return 0;
    if (y >= prev - over) return prev;
    const passed = T.find((v) => v >= y);
    const ahd = T.filter((v) => v < y).pop();
    return ahd === undefined || passed - y <= over ? passed : ahd;
  }

  function rest() {
    const y = window.scrollY;
    if (gliding) { gliding = false; y0 = y; }   // our own glide came to rest (no input since)
    restY = y;
    if (!pending) return;                      // a scroll no visitor asked for (a script, a hash jump)
    pending = false;
    const t = now();
    let to = null;
    // a touch fling's momentum can outlast any time window: it stays the visitor's until it rests
    if (on() && t - focusAt >= 800 && (touched || t - inputAt <= 1000) && !jump && !tallInView()) to = target(y);
    if (to === null || Math.abs(Math.max(0, Math.min(to, maxY())) - y) < 2) { y0 = y; return; }
    to = Math.max(0, Math.min(to, maxY()));
    gliding = true; glideTo = to; y0 = to; restY = to;
    window.scrollTo({ top: to, behavior: 'smooth' });
  }
  // A rest waits a moment, so the notches of one quick flick count as one gesture.
  const soon = () => { clearTimeout(restT); restT = setTimeout(rest, 140); };
  // (the scroll event can arrive after scrollend, so it never cancels a rest; only new input does)
  if ('onscrollend' in window) window.addEventListener('scrollend', soon);
  else window.addEventListener('scroll', soon, { passive: true });
})();

/* The beat track and the thread: job r-4f2a's five beats. The track sits in the right gutter at
 * 1400px and up and the thread under the topbar at 1024px and up (crew.css hides each below that, so
 * neither can sit over content). The track marks the beat in view (aria-current); each thread
 * segment fills as its beat comes into view. Both fade out once the page is past the last beat. */
(function beats() {
  const nav = document.querySelector('[data-beats]');
  const thread = document.querySelector('[data-thread]');
  if (!nav && !thread) return;
  const links = nav ? Array.prototype.slice.call(nav.querySelectorAll('[data-beat-link]')) : [];
  const ids = links.length ? links.map((a) => a.dataset.beatLink) : ['job', 'build', 'review', 'gate', 'deliver'];
  const secs = ids.map((id) => document.getElementById(id));
  const segs = thread ? Array.prototype.slice.call(thread.querySelectorAll('[data-thread-seg] b')) : [];
  let raf = 0;
  function paint() {
    raf = 0;
    const tb = topbarH(), vb = window.innerHeight;
    const mid = tb + (vb - tb) / 2;
    let cur = -1;
    secs.forEach((s, i) => {
      if (!s) return;
      const r = s.getBoundingClientRect();
      if (r.top <= mid && r.bottom > mid) cur = i;
      if (segs[i]) segs[i].style.setProperty('--f', Math.max(0, Math.min(1, (vb - r.top) / Math.max(1, r.height))).toFixed(3));
    });
    links.forEach((a, i) => { if (i === cur) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current'); });
    if (nav) nav.classList.toggle('is-on', cur >= 0);
    if (thread) thread.classList.toggle('is-on', cur >= 0);
  }
  const ask = () => { if (!raf) raf = requestAnimationFrame(paint); };
  window.addEventListener('scroll', ask, { passive: true });
  window.addEventListener('resize', ask);
  paint();
})();
