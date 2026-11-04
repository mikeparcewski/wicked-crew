/* The four beats' explorables, What's new and Get it.
 *
 * Swap, don't grow: every region below shows one of several states that are ALL rendered, stacked
 * in one grid cell (.stack > .stack-i), so the box is always as tall as its tallest state and a
 * hover, tap or autoplay step only crossfades inside it. Nothing here changes layout.
 * Motion runs only when the frame is in view, once, and never under prefers-reduced-motion (the
 * end state is shown instead). Every control is a real button with aria-pressed / aria-current.
 * Off screen (under a quarter of a region showing) or in a hidden tab, every autoplay holds where it
 * is and its CSS loops pause (offscreen.js); it carries on from there when it is back, unless the
 * visitor stopped it. */

import { pauseWhenOffscreen } from './offscreen.js';

// read live, so reduced motion switched on mid-visit stops an autoplay at its next step
const RM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const isReduced = () => RM.matches;
const $$ = (root, sel) => Array.prototype.slice.call(root.querySelectorAll(sel));

/** Run `cb` once, when `el` is at least `ratio` visible (the frame has locked in). */
function onLock(el, cb, ratio) {
  if (!('IntersectionObserver' in window)) { cb(); return; }
  const io = new IntersectionObserver((es) => {
    if (es.some((x) => x.isIntersecting)) { io.disconnect(); cb(); }
  }, { threshold: ratio || 0.55 });
  io.observe(el);
}
/** Show the stack item matching `pred`; hide the rest from assistive tech too. */
function swap(items, pred) {
  items.forEach((it) => {
    const on = pred(it);
    it.classList.toggle('is-on', on);
    if (on) it.removeAttribute('aria-hidden'); else it.setAttribute('aria-hidden', 'true');
  });
}
function press(btns, pred) { btns.forEach((b) => b.setAttribute('aria-pressed', pred(b) ? 'true' : 'false')); }
/** Stop an autoplay the moment the visitor takes over, and remember it: an autoplay that is still
 *  waiting for its frame to lock in must not start after the visitor has already touched it. */
function onTakeover(root, cb) {
  const st = { taken: false };
  const take = () => { st.taken = true; cb(); };
  ['pointerdown', 'keydown', 'focusin'].forEach((ev) => root.addEventListener(ev, take, { once: true }));
  return st;
}

/* ── S2 Build: the sandbox ─────────────────────────────────────────────── */
(function () {
  const root = document.querySelector('[data-sbx]');
  if (!root) return;
  const hots = $$(root, '[data-hot]');
  const agents = $$(root, '[data-agent]');
  const caps = $$(root, '[data-cap]');
  const agentName = root.querySelector('[data-sbx-agent]');
  function hot(key) {
    press(hots, (h) => h.dataset.hot === key);
    swap(caps, (c) => c.dataset.cap === key);
  }
  function agent(k) {
    press(agents, (a) => a.dataset.agent === String(k));
    agentName.textContent = agents[k].dataset.agentName;
    root.classList.toggle('is-benched', !agents[k].classList.contains('is-yes'));
    press(hots, () => false);
    swap(caps, (c) => c.dataset.cap === 'agent-' + k);
  }
  hots.forEach((h) => {
    const go = () => hot(h.dataset.hot);
    h.addEventListener('click', go);
    h.addEventListener('focus', go);
    h.addEventListener('mouseenter', go);
  });
  agents.forEach((a) => a.addEventListener('click', () => agent(parseInt(a.dataset.agent, 10))));
  swap(caps, (c) => c.classList.contains('is-on'));
  // the packet and the pulse are CSS loops: they pause with the sandbox off screen
  pauseWhenOffscreen(root);
})();

/* ── S3 Review: the dispute stepper ────────────────────────────────────── */
(function () {
  const root = document.querySelector('[data-disp]');
  if (!root) return;
  const steps = $$(root, '[data-dstep]');
  const panels = $$(root, '[data-dpanel]');
  const count = root.querySelector('[data-dcount]');
  const N = steps.length;
  let k = 0, timer = null, held = false;
  function go(n) {
    k = Math.max(0, Math.min(N - 1, n));
    steps.forEach((s, j) => {
      if (j === k) s.setAttribute('aria-current', 'step'); else s.removeAttribute('aria-current');
      s.classList.toggle('is-done', j < k);
    });
    swap(panels, (p) => p.dataset.dpanel === String(k));
    root.style.setProperty('--disp-k', String(k));
    count.textContent = (k + 1) + ' / ' + N;
  }
  function stop() { clearInterval(timer); timer = null; held = false; }
  function arm() { timer = setInterval(() => { if (isReduced() || k >= N - 1) { stop(); go(N - 1); return; } go(k + 1); }, 900); }
  function play() {
    stop(); go(0);
    if (isReduced()) { go(N - 1); return; }
    if (vis.live) arm(); else held = true;
  }
  // off screen it holds on its step; back on screen it carries on (a stop by the visitor stays)
  const vis = pauseWhenOffscreen(root, {
    stop() { if (isReduced()) { if (timer || held) { stop(); go(N - 1); } return; } if (timer) { clearInterval(timer); timer = null; held = true; } },
    start() { if (held) { held = false; arm(); } },
  });
  steps.forEach((s) => s.addEventListener('click', () => { stop(); go(parseInt(s.dataset.dstep, 10)); }));
  root.querySelector('[data-dprev]').addEventListener('click', () => { stop(); go(k - 1); });
  root.querySelector('[data-dnext]').addEventListener('click', () => { stop(); go(k + 1); });
  root.querySelector('[data-dreplay]').addEventListener('click', play);
  go(isReduced() ? N - 1 : 0);
  const touch = onTakeover(root, stop);
  if (!isReduced()) onLock(root, () => { if (!timer && !touch.taken && !isReduced()) play(); });
})();

/* ── S4 Gate: the receipt explorer ─────────────────────────────────────────
   Each label marks ONLY the layers it speaks about (studio GateVerdict.tsx): "floor only" is a
   pass where the floor (with the repo checks) ran and no distinct judge reviewed it; "approved by
   default, not verified" is a phase nothing gated; "reduced assurance" waives the distinct
   reviewer; the QE skip is the operator's, with a reason. Unmarked layers read "—". */
(function () {
  const root = document.querySelector('[data-rcx]');
  if (!root) return;
  const opts = $$(root, '[data-scen]');
  const stamps = $$(root, '[data-stamp]');
  const states = $$(root, '[data-s]');
  const rows = $$(root, '[data-layer]');
  const lbtns = $$(root, '[data-layer-btn]');
  const details = $$(root, '[data-detail]');
  const whens = $$(root, '[data-when]');
  const SCEN = {
    full: { focus: 'eval', s: { floor: 'ran', checks: 'ran', eval: 'ran · Codex', judge: 'ran', qe: 'PASS' } },
    nogate: { focus: 'nogate', s: { floor: 'no gate', checks: 'no gate', eval: 'no gate', judge: 'no gate', qe: 'no gate' } },
    floor: { focus: 'floor', s: { floor: 'ran', checks: 'ran', eval: '—', judge: 'no distinct judge', qe: '—' } },
    reduced: { focus: 'eval', s: { floor: '—', checks: '—', eval: 'the builder', judge: '—', qe: '—' } },
    qeskip: { focus: 'qe', s: { floor: '—', checks: '—', eval: '—', judge: '—', qe: 'skipped, with your reason' } },
  };
  const TONE = { 'ran': 'ok', 'ran · Codex': 'ok', 'PASS': 'ok', 'no gate': 'warn', 'no distinct judge': 'warn', 'the builder': 'warn', 'skipped, with your reason': 'warn', '—': 'none' };
  let timer = null, held = false, order = [], j = 0;
  function layer(key) {
    press(lbtns, (b) => b.dataset.layerBtn === key);
    swap(details, (d) => d.dataset.detail === key);
  }
  function scen(key) {
    const sc = SCEN[key];
    press(opts, (o) => o.dataset.scen === key);
    swap(stamps, (s) => s.dataset.stamp === key);
    whens.forEach((w) => w.classList.toggle('is-on', w.dataset.when === key));
    states.forEach((s) => { const v = sc.s[s.dataset.s]; s.textContent = v; s.dataset.tone = TONE[v] || 'none'; });
    rows.forEach((r) => r.classList.toggle('is-marked', sc.s[r.dataset.layer] !== '—'));
    root.dataset.scen = key;
    layer(sc.focus);
  }
  opts.forEach((o) => o.addEventListener('click', () => { stop(); scen(o.dataset.scen); }));
  lbtns.forEach((b) => b.addEventListener('click', () => { stop(); layer(b.dataset.layerBtn); }));
  function stop() { clearInterval(timer); timer = null; held = false; }
  function arm() { timer = setInterval(() => { if (isReduced()) { stop(); scen('full'); return; } scen(order[j++]); if (j >= order.length) stop(); }, 2200); }
  // off screen it holds on its label; back on screen it carries on (a touch by the visitor stays)
  const vis = pauseWhenOffscreen(root, {
    stop() { if (isReduced()) { if (timer || held) { stop(); scen('full'); } return; } if (timer) { clearInterval(timer); timer = null; held = true; } },
    start() { if (held) { held = false; arm(); } },
  });
  scen('full');
  // Autoplay once through the labels when the frame locks in, back to PASS; the visitor's first
  // touch stops it where it is.
  if (!isReduced()) {
    const touch = onTakeover(root, stop);
    onLock(root, () => {
      if (touch.taken || isReduced()) return;
      order = ['nogate', 'floor', 'reduced', 'qeskip', 'full'];
      j = 0;
      if (vis.live) arm(); else held = true;
    });
  }
})();

/* ── S5 Deliver: workflows on a rail; crash it, start it again ─────────── */
(function () {
  const root = document.querySelector('[data-wf]');
  if (!root) return;
  const tabs = $$(root, '[data-wf-tab]');
  const panels = $$(root, '[data-wf-panel]');
  const crash = root.querySelector('[data-wf-crash]');
  const status = root.querySelector('[data-wf-status]');
  // the button's two labels are stacked in it, so the swap never resizes it
  const setLabel = (key) => crash.querySelectorAll('[data-l]').forEach((l) => {
    const on = l.dataset.l === key; l.classList.toggle('is-on', on);
    if (on) l.removeAttribute('aria-hidden'); else l.setAttribute('aria-hidden', 'true');
  });
  let w = 0, k = 0, dead = false, timer = null, inView = false, finished = false;
  const nodes = () => $$(panels[w], '[data-node]');
  // a workflow that is one line, not a sequence of steps, has no step counter: it is named by its name
  const single = () => panels[w].classList.contains('is-single');
  const label = (n) => (single() ? tabs[w].textContent.trim() : n.querySelector('.wf-s').textContent);
  const at = (ns, j) => (single() ? 'running · ' : 'step ' + (j + 1) + ' of ' + ns.length + ' · ') + '<b>' + label(ns[j]) + '</b>';
  function paint() {
    const ns = nodes();
    ns.forEach((n, j) => {
      n.classList.toggle('is-done', finished || j < k);
      n.classList.toggle('is-now', !finished && j === k && !dead);
      n.classList.toggle('is-down', !finished && j === k && dead);
    });
    panels[w].style.setProperty('--wf-p', String(finished ? ns.length : k));
    panels[w].classList.toggle('is-dead', dead);
  }
  function say(html) { status.innerHTML = html; }
  function stopT() { clearTimeout(timer); timer = null; }
  function tick() {
    stopT();
    // under reduced motion (even switched on mid-visit) the rail shows the finished job, still
    if (isReduced()) { if (!dead && !finished && inView) { finished = true; paint(); say('done · evidence bundle ready'); } return; }
    if (dead || !inView) return;
    const ns = nodes();
    timer = setTimeout(() => {
      // reduced motion switched on while this tick waited: the finished job, at once
      if (isReduced()) { stopT(); finished = true; dead = false; paint(); say('done · evidence bundle ready'); return; }
      if (finished) { finished = false; k = 0; paint(); say(at(ns, 0)); tick(); return; }
      if (k >= ns.length - 1) { finished = true; paint(); say('done · evidence bundle ready'); timer = setTimeout(tick, 600); return; }
      k++; paint(); say(at(ns, k)); tick();
    }, finished ? 1800 : 1100);
  }
  function pick(n) {
    stopT();
    w = n; k = 0; dead = false; finished = isReduced();
    press(tabs, (t) => t.dataset.wfTab === String(n));
    swap(panels, (p) => p.dataset.wfPanel === String(n));
    setLabel('crash');
    const ns = nodes();
    paint();
    say(isReduced() ? 'done · evidence bundle ready' : at(ns, 0));
    tick();
  }
  crash.addEventListener('click', () => {
    const ns = nodes();
    if (!dead) {
      stopT();
      // A finished job has nothing to crash: crash the next run of it, mid-way.
      if (finished) { finished = false; k = Math.floor((ns.length - 1) / 2); }
      dead = true; paint();
      setLabel('start');
      say('<span class="deny">— daemon killed mid-job —</span> at <b>' + label(ns[k]) + '</b>');
      return;
    }
    dead = false;
    setLabel('crash');
    say('<span class="ctrl">run.resumed {via: boot}</span> · re-entering <b>' + label(ns[k]) + '</b>');
    if (isReduced()) { finished = true; }
    paint();
    tick();
  });
  tabs.forEach((t) => t.addEventListener('click', () => pick(parseInt(t.dataset.wfTab, 10))));
  pick(0);
  // it steps only while a quarter of it is on screen and the tab is visible; a crash stays crashed.
  // Reduced motion switched on mid-run shows the finished job, still.
  pauseWhenOffscreen(root, {
    start() { inView = true; tick(); },
    stop() {
      inView = false; stopT();
      if (isReduced() && !dead && !finished) { finished = true; paint(); say('done · evidence bundle ready'); }
    },
  });
})();

/* ── S6 What's new: tiles stagger in; on phones, a carousel ────────────── */
(function () {
  const list = document.querySelector('[data-news]');
  if (!list) return;
  const sec = list.closest('section');
  const items = $$(list, 'li');
  const dots = $$(sec, '[data-car-dots] i');
  const count = sec.querySelector('[data-car-count]');
  if (!isReduced()) { sec.classList.add('will-stagger'); onLock(list, () => sec.classList.add('is-in'), 0.3); }
  // leaving mid-stagger lands every tile at once (offscreen.js settles one-shot transitions)
  pauseWhenOffscreen(list);
  let cur = 0;
  function mark(n) {
    cur = n;
    dots.forEach((d, j) => d.classList.toggle('on', j === n));
    count.textContent = (n + 1) + ' of ' + items.length;
  }
  function to(n) {
    n = Math.max(0, Math.min(items.length - 1, n));
    list.scrollTo({ left: items[n].offsetLeft - list.offsetLeft, behavior: isReduced() ? 'auto' : 'smooth' });
    mark(n);
  }
  sec.querySelector('[data-car-prev]').addEventListener('click', () => to(cur - 1));
  sec.querySelector('[data-car-next]').addEventListener('click', () => to(cur + 1));
  let raf = 0;
  list.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const x = list.scrollLeft;
      let best = 0, bd = Infinity;
      items.forEach((it, j) => { const d = Math.abs(it.offsetLeft - list.offsetLeft - x); if (d < bd) { bd = d; best = j; } });
      mark(best);
    });
  }, { passive: true });
  mark(0);
})();

/* ── S8 Get it: the command types itself once ──────────────────────────── */
(function () {
  const t = document.querySelector('[data-type]');
  if (!t || isReduced()) return;
  const box = t.closest('.install');
  t.classList.add('is-armed');
  let done = null;
  const unclip = () => { clearTimeout(done); t.classList.remove('is-armed', 'is-typing'); };
  onLock(box, () => {
    t.classList.add('is-typing');
    // the command is never left hidden: once the typing is over (or if animations never run), unclip it
    done = setTimeout(unclip, 3300);
  }, 0.6);
  // leaving the screen mid-typing shows the whole command at once: nothing types while nobody sees it
  pauseWhenOffscreen(box, { stop() { if (t.classList.contains('is-typing')) unclip(); } });
})();
