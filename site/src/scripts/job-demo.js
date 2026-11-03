/* The hero's job demo: a list of steps; a pointer walks it; decisions pause it.
 *
 * Poster first: the page paints the FINISHED job (five gates passed, the delivery receipt open,
 * the pull request lit), so the first frame is never an empty box; the job replays once the card
 * is 40% visible. Under prefers-reduced-motion the poster stays (the end state) and Run goes
 * straight to the QE decision, with no animation.
 *
 * The log is a short window in large type: the newest lines, at most five, and only as many as fit
 * whole. A replay starts from an empty log, so nothing of the previous run stays on screen.
 *
 * Keyboard: no control is ever `disabled` (a disabled button drops focus to <body>); a control
 * that cannot act says aria-disabled and ignores the click. When the panel's content is replaced
 * while focus is inside it, focus moves to the new content's first control (or the panel). */

const root = document.querySelector('[data-job]');
if (root) initJob(root);

function initJob(root) {
  // read live, so reduced motion switched on mid-replay runs the rest of it at once
  const RM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const logEl = root.querySelector('[data-log]');
  const panel = root.querySelector('[data-panel]');
  const capN = root.querySelector('[data-caption-n]');
  const capT = root.querySelector('[data-caption-t]');
  const runBtn = root.querySelector('[data-job-run]');
  const killBtn = root.querySelector('[data-job-kill]');
  const prChip = root.querySelector('[data-pr]');
  const rail = root.querySelector('[data-rail]');
  const sts = Array.prototype.slice.call(root.querySelectorAll('[data-st]'));
  const gates = Array.prototype.slice.call(root.querySelectorAll('[data-gate]'));
  const NAMES = ['Plan', 'Build', 'Review', 'QE', 'Deliver'];

  // One plain caption per beat, built from the demo's own lines.
  const CAPS = {
    plan: ['1', 'You confirm the plan (this job runs phased, one gate per step).'],
    build: ['2', 'Claude Code builds it in its sandbox.'],
    review: ['3', 'Codex, a different agent, reviews it.'],
    council: ['3', 'A council settles the dispute.'],
    qe: ['4', 'QE acceptance decides delivery.'],
    deliver: ['5', 'A pull request, with receipts.'],
    down: ['!', 'The daemon is down. The job is still on disk, at the step it was on.'],
    up: ['↻', 'Resumed at the step it was on; finished steps stay finished.'],
  };

  // Receipts, one per gate, filled as the job reaches them.
  let R = {};
  const RECEIPTS = {
    0: { title: 'Plan gate', verdict: 'PASS', rows: [['Required', 'you confirm the plan'], ['Ran', 'operator approval'], ['Decided by', 'you']] },
    1: { title: 'Build gate', verdict: 'PASS', rows: [['Required', 'evidence check, your policies'], ['Ran', 'evidence check: worktree changed · PASS'], ['', 'policy schema-drift · PASS'], ['Built by', 'Claude Code, in its sandbox'], ['Skipped', 'nothing']] },
    2: { title: 'Review gate', verdict: 'PASS', rows: [['Evaluator', 'Codex (a different agent)'], ['Findings', '1 → disputed → council'], ['Council', 'finding stands · 2 of 3 · seed 4127'], ['Drawn', 'Pi, OpenCode, Copilot (OpenCode dissented)'], ['Send-backs', '1 (you are asked after 2)']] },
    3: { title: 'QE gate', verdict: 'PASS', rows: [['Required', 'built-in feature job'], ['Read', 'GET /api/v1/runs/r-4f2a/acceptance'], ['Ledger', 'PASS, attributed to r-4f2a']] },
    4: { title: 'Delivery', verdict: 'DELIVERED', rows: [['Pull request', '#42 from wicked/r-4f2a'], ['Assurance', 'full: built and reviewed by different agents'], ['QE acceptance', 'PASS'], ['Evidence', 'bundle ready to export']] },
  };

  // The council's draw: 3 of 4 eligible agents light up.
  const SEATS = '<span class="ln-seats" aria-hidden="true"><i class="on">Pi</i><i class="on">OpenCode</i><i class="on">Copilot</i><i>not drawn</i></span>';

  // The script. `p` = phase index; `gate` marks the step that closes a phase's gate;
  // `wait` pauses for the visitor; `cap` switches the plain caption.
  const S = [
    { p: 0, t: 'run.launched · workflow <b>feature</b>', cap: 'plan' },
    { p: 0, t: 'plan proposed from the feature workflow' },
    { p: 0, t: 'plan confirmed by you', gate: 0 },
    { p: 1, t: 'container started · <b>Claude Code</b> · repo read-only, worktree writable', cap: 'build' },
    { p: 1, t: 'egress: the model gateway only · keys stay in the broker; the sandbox sees placeholders' },
    { p: 1, t: 'writing the change · usage 41k in / 6k out' },
    { p: 1, t: 'diff captured · 3 files' },
    { p: 1, t: 'gate: evidence check PASS · schema-drift PASS', c: 'ok', gate: 1 },
    { p: 2, t: 'review goes to <b>Codex</b>, a different agent than the builder', cap: 'review' },
    { p: 2, t: 'Codex finding (high): the limit is keyed on IP; the brief says per API key · rateLimit.ts:12', c: 'warn' },
    { p: 2, t: 'Claude Code declines: “IP is right for routes with no key”' },
    { p: 2, t: 'Codex holds the finding → <b>dispute</b>', c: 'warn', cap: 'council' },
    { p: 2, t: 'council convened: 3 of 4 eligible agents, seed 4127 · Pi, OpenCode, Copilot', c: 'ctrl', seats: true },
    { p: 2, t: 'council ruled: <b>finding stands</b> · 2 of 3 · OpenCode dissented', c: 'ctrl' },
    { p: 2, t: 'sent back to Build with the ruling' },
    { p: 2, t: 'Claude Code: limit is now per API key, IP only when no key is sent' },
    { p: 2, t: 'Codex: PASS', c: 'ok', gate: 2 },
    { p: 3, t: 'QE acceptance <b>required</b>: a feature job passes it before delivery', cap: 'qe' },
    { p: 3, t: 'garden’s QE pipeline ran; its verdict is in the QE ledger' },
    { p: 3, wait: 'qe' },
    { p: 4, t: 'pushed wicked/r-4f2a · pull request <b>#42</b> opened', c: 'ok', cap: 'deliver' },
    { p: 4, t: 'done · evidence bundle ready', c: 'ok', gate: 4 },
  ];
  const PASS_LINE = 'acceptance read: <b>PASS</b>, attributed to r-4f2a';

  let i = 0, timer = null, running = false, dead = false, waiting = null, selected = null, booted = false;
  const STEP = 750;

  // A button's labels are stacked in it (the box is the widest label): swap, never resize.
  function label(btn, key) {
    btn.querySelectorAll('[data-l]').forEach(function (l) {
      const on = l.getAttribute('data-l') === key;
      l.classList.toggle('is-on', on);
      if (on) l.removeAttribute('aria-hidden'); else l.setAttribute('aria-hidden', 'true');
    });
  }
  function setOff(btn, off) { btn.setAttribute('aria-disabled', off ? 'true' : 'false'); }
  function isOff(btn) { return btn.getAttribute('aria-disabled') === 'true'; }

  function line(html, cls, still, seats) {
    const el = document.createElement('p');
    el.className = 'ln' + (cls ? ' ln--' + cls : '') + (still ? ' ln--still' : '');
    el.innerHTML = html + (seats ? ' ' + SEATS : '');
    const before = still ? null : tops();
    logEl.appendChild(el);
    if (sizes) sizes.observe(el);
    fit();
    if (before) slide(before);
  }
  /** The log shows a short window: the newest lines, at most WINDOW of them, and only as many as fit
   *  whole (an older line is hidden, never sliced through at the top edge). Hidden lines stay in the
   *  log, so a window that grows shows them again. */
  const WINDOW = 5;
  // The window refits whenever the log or one of its lines changes size: a resize, and a rewrap that
  // leaves the log's own box alone (the web font arriving after the poster was fitted, text spacing).
  // The refit runs on the next frame, outside the observer's delivery (hiding a line resizes it).
  let refit = 0;
  const sizes = 'ResizeObserver' in window ? new ResizeObserver(function () {
    if (!refit) refit = requestAnimationFrame(function () { refit = 0; fit(); });
  }) : null;
  // Whether the lines fit is read from their laid-out boxes (offsetTop within the log), never from
  // scrollHeight: a running glide's transform adds to the scrolled overflow, not to the layout.
  function fit() {
    const ls = logEl.querySelectorAll('.ln');
    const n = ls.length;
    let first = Math.max(0, n - WINDOW);
    for (let k = 0; k < n; k++) ls[k].hidden = k < first;
    if (!n) return;
    const room = logEl.clientHeight - parseFloat(getComputedStyle(logEl).paddingBottom);
    const last = ls[n - 1];
    while (first < n - 1 && last.offsetTop + last.offsetHeight > room + 1) ls[first++].hidden = true;
  }
  function clearLog() {
    if (sizes) { sizes.disconnect(); sizes.observe(logEl); }
    glides = [];
    logEl.innerHTML = '';
  }
  // where each shown line sits before a new one arrives, so the window can glide up into place
  function tops() {
    if (RM.matches || !logEl.animate) return null;
    const m = new Map();
    logEl.querySelectorAll('.ln:not([hidden])').forEach(function (l) { m.set(l, l.offsetTop); });
    return m;
  }
  // When older lines leave the window, every line still shown moves up by the same distance, and the
  // new one rises in from just under them: they move together, so the spacing holds the whole way and
  // no line ever passes over another. A new glide takes over from one still running (a restart adds
  // two lines at once): the old one is dropped, and the new one covers every line shown.
  let glides = [];
  function slide(before) {
    let dy = 0;
    before.forEach(function (top, l) { if (!dy && !l.hidden) dy = top - l.offsetTop; });
    if (!dy) return;
    glides.forEach(function (a) { a.cancel(); });
    glides = Array.prototype.map.call(logEl.querySelectorAll('.ln:not([hidden])'), function (l) {
      return l.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' });
    });
  }
  // reduced motion switched on mid-glide: the lines land at once
  if (RM.addEventListener) RM.addEventListener('change', function () {
    if (RM.matches) { glides.forEach(function (a) { a.finish(); }); glides = []; }
  });
  function caption(key) {
    const c = CAPS[key];
    if (!c) return;
    capN.textContent = c[0];
    capT.textContent = c[1];
    root.querySelector('[data-caption]').classList.remove('is-new');
    // restart the crossfade (a reflow between remove and add)
    void capT.offsetWidth;
    root.querySelector('[data-caption]').classList.add('is-new');
  }
  function phase() { return i < S.length ? S[i].p : 4; }
  function paintTrack() {
    const cur = running || waiting ? phase() : -1;
    let done = 0;
    sts.forEach(function (st, k) {
      const passed = !!(R[k] && R[k].verdict !== 'HELD');
      if (passed) done++;
      st.classList.toggle('is-done', passed);
      st.classList.toggle('is-now', k === cur && !dead && !passed);
      st.classList.toggle('is-held', !!(R[k] && R[k].verdict === 'HELD'));
      st.classList.toggle('is-down', k === cur && dead);
      setOff(gates[k], !R[k]);
      gates[k].setAttribute('aria-pressed', selected === k ? 'true' : 'false');
    });
    // QE has no gate step of its own in the script: it closes when the verdict is read.
    const frac = Math.min(1, (done + (cur >= 0 && !R[cur] ? 0.5 : 0)) / 5);
    rail.style.transform = 'scaleX(' + frac.toFixed(3) + ')';
    rail.classList.toggle('is-down', dead);
    prChip.classList.toggle('is-lit', !!R[4]);
  }
  function stamp(k) {
    const g = gates[k];
    g.classList.remove('is-stamp');
    void g.offsetWidth;
    g.classList.add('is-stamp');
  }
  // Replace the panel's content; keep keyboard focus inside it if it was there.
  function setPanel(html) {
    const had = panel.contains(document.activeElement);
    panel.innerHTML = html;
    if (had) {
      const first = panel.querySelector('button');
      (first || panel).focus({ preventScroll: true });
    }
  }
  function showReceipt(k) {
    const r = R[k];
    if (!r) return;
    selected = k;
    const cls = r.verdict === 'HELD' ? 'deny' : 'ok';
    setPanel('<div class="rc"><div class="rc-head"><span>' + r.title + '</span><span class="rc-v rc-v--' + cls + '">' + r.verdict + '</span></div>' +
      '<table><tbody>' + r.rows.map(function (row) { return '<tr><th>' + row[0] + '</th><td>' + row[1] + '</td></tr>'; }).join('') + '</tbody></table></div>');
    paintTrack();
  }
  function idlePanel(text) { selected = null; setPanel('<p class="panel-empty">' + text + '</p>'); paintTrack(); }

  const PICKS = '<button type="button" class="pick pick--yes" data-qe="PASS">PASS</button>' +
    '<button type="button" class="pick" data-qe="CONDITIONAL">CONDITIONAL</button>' +
    '<button type="button" class="pick" data-qe="NONE">No verdict</button>';
  function qePanel() {
    selected = null;
    setPanel('<div class="ask"><p class="ask-q">What did the QE ledger record for this job?</p>' +
      '<p class="ask-sub">Pick one to see the delivery gate decide.</p><div class="ask-acts">' + PICKS + '</div></div>');
    paintTrack();
  }
  function answerQe(v) {
    if (waiting !== 'qe' || dead) return;
    if (v !== 'PASS') {
      const why = v === 'CONDITIONAL' ? 'CONDITIONAL is not a pass' : 'no verdict is not a pass';
      line('delivery refused · <b>409 qe_acceptance_required</b> · ' + why, 'deny');
      R[3] = { title: 'QE gate', verdict: 'HELD', rows: [['Required', 'built-in feature job'], ['Ledger', v === 'NONE' ? 'no verdict for r-4f2a' : 'CONDITIONAL for r-4f2a'], ['Delivery', 'refused until an attributed PASS']] };
      const had = panel.contains(document.activeElement);
      showReceipt(3);
      panel.insertAdjacentHTML('beforeend', '<p class="ask-again">Nothing ships. Pick again: ' + PICKS + '</p>');
      if (had) { const again = panel.querySelector('.ask-again [data-qe="' + v + '"]'); if (again) again.focus({ preventScroll: true }); }
      return;
    }
    line(PASS_LINE, 'ok');
    R[3] = RECEIPTS[3];
    stamp(3);
    waiting = null;
    i++;
    showReceipt(3);
    go();
  }

  function stepOnce() {
    if (dead || waiting) return;
    if (i >= S.length) { finish(); return; }
    const s = S[i];
    if (s.cap) caption(s.cap);
    if (s.wait) { waiting = s.wait; qePanel(); return; }
    line(s.t, s.c, false, s.seats);
    if (s.gate !== undefined) { R[s.gate] = RECEIPTS[s.gate]; stamp(s.gate); showReceipt(s.gate); }
    i++;
    paintTrack();
  }
  function go() {
    clearTimeout(timer);
    if (RM.matches) { while (!dead && !waiting && i < S.length) stepOnce(); if (i >= S.length) finish(); return; }
    (function tick() {
      if (dead || waiting) return;
      if (RM.matches) { go(); return; }
      stepOnce();
      if (i >= S.length) { finish(); return; }
      if (!waiting) timer = setTimeout(tick, STEP);
    })();
  }
  function finish() {
    running = false; setOff(killBtn, true); setOff(runBtn, false); label(runBtn, 'again');
    if (R[4]) showReceipt(4);
    paintTrack();
  }
  function start() {
    clearTimeout(timer);
    clearLog(); R = {}; i = 0; dead = false; waiting = null; running = true;
    setOff(runBtn, true); setOff(killBtn, false); label(killBtn, 'kill');
    idlePanel('Each gate’s receipt opens here as the job reaches it. Click a gate on the track to reopen one.');
    go();
  }
  function kill() {
    if (!running) return;
    if (!dead) {
      clearTimeout(timer);
      dead = true;
      line('— daemon killed mid-job —', 'deny');
      label(killBtn, 'start');
      caption('down');
      // (the caption says what happened; the panel says what to do, so a phone never reads it twice)
      idlePanel('Start the daemon: its boot sweep finds the job and re-enters the step it was on.');
      return;
    }
    // Restart: the boot sweep finds the orphaned job and re-enters the step it was on.
    dead = false;
    label(killBtn, 'kill');
    const p = phase();
    line('daemon up · boot sweep found r-4f2a orphaned', 'ctrl');
    line('run.resumed {via: boot} · re-entering <b>' + NAMES[p] + '</b> · the step it was on runs again; finished steps stay finished', 'ctrl');
    caption('up');
    if (waiting === 'qe') { qePanel(); paintTrack(); return; }
    // Re-enter the current phase from its first step (the unit it was on), never an earlier one.
    while (i > 0 && S[i - 1].p === p && S[i - 1].gate === undefined) i--;
    idlePanel('Resumed. Each gate’s receipt opens here as the job reaches it.');
    go();
  }

  // The finished job, painted at once: every line, every gate, the delivery receipt.
  function poster() {
    clearLog();
    S.forEach(function (s) { if (s.wait) line(PASS_LINE, 'ok', true); else line(s.t, s.c, true, s.seats); });
    R = {}; Object.keys(RECEIPTS).forEach(function (k) { R[k] = RECEIPTS[k]; });
    i = S.length; running = false; waiting = null; dead = false;
    setOff(runBtn, false); setOff(killBtn, true);
    caption('deliver');
    showReceipt(4);
  }

  root.addEventListener('click', function (e) {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    const qe = t.closest('[data-qe]');
    if (qe) { answerQe(qe.getAttribute('data-qe')); return; }
    const g = t.closest('[data-gate]');
    // opening a receipt is taking control: the automatic replay must not clear it a moment later
    if (g && !isOff(g)) { booted = true; showReceipt(parseInt(g.getAttribute('data-gate'), 10)); return; }
  });
  runBtn.addEventListener('click', function () { if (isOff(runBtn)) return; booted = true; start(); });
  killBtn.addEventListener('click', function () { if (isOff(killBtn)) return; kill(); });

  poster();
  // a window resize changes the log's height: the window shows as many of the newest lines as fit
  if (sizes) sizes.observe(logEl);
  // a web font that arrives (now or later, either wider or narrower) can rewrap a hidden line too,
  // which no observer sees: the window refits from scratch
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', function () { fit(); });
  if (RM.matches) return;
  // a replay still waiting to start does not start once reduced motion is on (Run still runs it)
  function auto() { if (!booted && !RM.matches) { booted = true; start(); } }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(function (es) {
      if (es.some(function (x) { return x.isIntersecting; })) { io.disconnect(); setTimeout(auto, 1600); }
    }, { threshold: 0.4 });
    io.observe(root);
  } else { setTimeout(auto, 1600); }
}
