/* Frame settle + the beat track. ONE mechanism for "a frame locks in": CSS scroll-snap is off on
 * this page (crew.css), because Chromium's `proximity` captures anything within a third of a frame,
 * so slow wheel notches from a frame top were pulled straight back to it (10 x 100px notches left
 * scrollY at 0 at 1440x700 and 1920x1080).
 *
 * The settle never pulls against the visitor: when a user scroll comes to rest, it glides to the
 * next frame top IN THE DIRECTION OF TRAVEL, and only when that top is within 45% of a frame.
 * It is off below 1024px wide or 640px tall, under prefers-reduced-motion, while a section taller
 * than its frame is in view, and after a focus-driven scroll (Tab), so focus never jumps away. */

const reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const topbarH = () => { const b = document.querySelector('.topbar'); return b ? b.getBoundingClientRect().height : 64; };
const now = () => (window.performance ? performance.now() : Date.now());

(function settle() {
  const RANGE = 0.45;
  let lastY = window.scrollY, dir = 0, gliding = false, focusAt = -1e9, inputAt = -1e9, debounce = 0;
  const on = () => window.innerWidth >= 1024 && window.innerHeight >= 640 && !reduceMQ.matches;

  const user = () => { inputAt = now(); };
  ['wheel', 'touchmove', 'pointerdown'].forEach((ev) => window.addEventListener(ev, user, { passive: true }));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { focusAt = now(); return; }
    if (['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' ', 'Home', 'End'].indexOf(e.key) >= 0) user();
  });
  window.addEventListener('focusin', () => { focusAt = now(); });

  function frames() {
    const tb = topbarH(), y = window.scrollY;
    return Array.prototype.slice.call(document.querySelectorAll('[data-frame], .same-garden, .footer'))
      .map((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + y - tb), h: r.height }; })
      .sort((a, b) => a.top - b.top);
  }
  function rest() {
    if (gliding) { gliding = false; return; }
    if (!on()) return;
    const t = now();
    if (t - focusAt < 800) return;          // focus moved the page: leave it where focus put it
    if (t - inputAt > 1500) return;          // not a user scroll (a hash jump, a script)
    const tb = topbarH(), vh = window.innerHeight - tb, y = window.scrollY;
    const fs = frames();
    // a section taller than its frame is being read: no settle
    if (fs.some((f) => f.h > vh + 2 && f.top < y + vh - 1 && f.top + f.h > y + 1)) return;
    let target = null;
    if (dir > 0) {
      const next = fs.find((f) => f.top > y + 1);
      if (next && next.top - y <= RANGE * vh) target = next.top;
    } else if (dir < 0) {
      const prev = fs.slice().reverse().find((f) => f.top < y - 1);
      if (prev && y - prev.top <= RANGE * vh) target = prev.top;
    }
    if (target === null) return;
    target = Math.max(0, Math.min(target, document.documentElement.scrollHeight - window.innerHeight));
    if (Math.abs(target - y) < 2) return;
    gliding = true;
    window.scrollTo({ top: target, behavior: 'smooth' });
  }
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y !== lastY) dir = y > lastY ? 1 : -1;
    lastY = y;
    if (!('onscrollend' in window)) { clearTimeout(debounce); debounce = setTimeout(rest, 160); }
  }, { passive: true });
  window.addEventListener('scrollend', rest);
})();

/* The beat track: job r-4f2a's five beats, in the right gutter at 1400px and up (crew.css hides it
 * below that, so it can never sit over content). It shows the beat in view (aria-current) and
 * hides once the page is past the job's last beat. */
(function beats() {
  const nav = document.querySelector('[data-beats]');
  if (!nav) return;
  const links = Array.prototype.slice.call(nav.querySelectorAll('[data-beat-link]'));
  const secs = links.map((a) => document.getElementById(a.dataset.beatLink));
  let raf = 0;
  function paint() {
    raf = 0;
    const mid = topbarH() + (window.innerHeight - topbarH()) / 2;
    let cur = -1;
    secs.forEach((s, i) => { if (!s) return; const r = s.getBoundingClientRect(); if (r.top <= mid && r.bottom > mid) cur = i; });
    links.forEach((a, i) => { if (i === cur) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current'); });
    nav.classList.toggle('is-on', cur >= 0);
  }
  window.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(paint); }, { passive: true });
  window.addEventListener('resize', () => { if (!raf) raf = requestAnimationFrame(paint); });
  paint();
})();
