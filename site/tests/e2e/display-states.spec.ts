import { test, expect, type Page } from '@playwright/test';

/**
 * Display states the first v2 build got wrong (fix round 1). Each test fails on that build:
 *  - the topbar tooltips opened ABOVE the 64px bar, off the top of the window (a 5px sliver showed);
 *  - a lit family plane cast a 56px glow below itself, under the text below and into Get it;
 *  - state text was cut off with an ellipsis in fixed boxes (the receipt's "skipped, with your
 *    reas…", the workflow status line at a long step, the phone caption);
 *  - the hero log was a scroller with a sub-pixel of travel, so the wheel over it never scrolled
 *    the page at 1920x1080 (the visitor was stuck in the hero);
 *  - a replay emptied the log to a box holding 1 to 3 lines.
 * The tooltip and plane rules are site-local overrides of the shared chrome (crew.css).
 *
 * Operator feedback on that fix (2026-11-02): the log was "text on text", like landing on a system
 * crash. It is now a short window in 16px type with 12px between lines (the newest five that fit
 * whole), and a replay starts from an empty log: the previous run's lines no longer stay, dimmed.
 */

async function settled(page: Page) {
  // wait for the wheel's own scroll, the settle's short pause before it acts (140ms) and its glide:
  // the position must hold for half a second
  let last = -1, same = 0;
  for (let k = 0; k < 50; k++) {
    await page.waitForTimeout(120);
    const y = await page.evaluate(() => Math.round(window.scrollY));
    same = y === last ? same + 1 : 0;
    if (same >= 4) return y;
    last = y;
  }
  return last;
}

test.describe('the shared chrome, as this site shows it', () => {
  test.use({ viewport: { width: 1440, height: 700 } });

  test('every topbar tooltip opens below the bar, inside the window', async ({ page }) => {
    await page.goto('/');
    const tips = page.locator('.topbar [data-tip]:visible');
    const n = await tips.count();
    expect(n).toBeGreaterThanOrEqual(4);
    for (let k = 0; k < n; k++) {
      const tip = tips.nth(k);
      await tip.hover();
      await page.waitForTimeout(250);
      const r = await tip.evaluate((el) => {
        const cs = getComputedStyle(el, '::after');
        const box = el.getBoundingClientRect();
        const top = box.top + parseFloat(cs.top);
        const pad = cs.boxSizing === 'border-box' ? 0 : parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
        const w = parseFloat(cs.width) + pad;
        const shift = cs.transform && cs.transform !== 'none' ? new DOMMatrix(cs.transform).m41 : 0;
        const left = box.left + parseFloat(cs.left) + shift;
        return { tip: el.getAttribute('data-tip'), opacity: cs.opacity, top, left, right: left + w, bar: document.querySelector('.topbar')!.getBoundingClientRect().bottom };
      });
      expect(r.opacity, `"${r.tip}" tooltip is not shown on hover`).toBe('1');
      expect(r.top, `"${r.tip}" tooltip opens above the window`).toBeGreaterThanOrEqual(0);
      expect(r.top, `"${r.tip}" tooltip is not below the bar's controls`).toBeGreaterThan(40);
      expect(r.left, `"${r.tip}" tooltip leaves the window on the left`).toBeGreaterThanOrEqual(0);
      expect(r.right, `"${r.tip}" tooltip leaves the window on the right`).toBeLessThanOrEqual(1440);
    }
  });

  test('a lit family plane keeps its glow inside its own box', async ({ page }) => {
    await page.goto('/');
    const planes = page.locator('.same-garden .sg-plane');
    await planes.last().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await planes.last().hover();
    await page.waitForTimeout(400);
    const shadow = await planes.last().evaluate((el) => getComputedStyle(el).boxShadow);
    // one 1px ring and nothing else: no offset, no blur
    const layers = shadow.split(/,(?![^(]*\))/).map((s) => s.trim());
    expect(layers.length, shadow).toBe(1);
    expect(shadow, shadow).toMatch(/0px 0px 0px 1px/);
    // and a card inside a plane does not lift into the plane's padding
    const card = planes.first().locator('.sg-card').first();
    await card.hover();
    await page.waitForTimeout(400);
    expect(await card.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  });
});

/** Puts every state a fixed box can show into it and reports any that does not fit. */
async function cutStates(page: Page) {
  return page.evaluate(() => {
    const bad: string[] = [];
    const over = (el: Element) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    const VALS = ['ran', 'ran · Codex', 'PASS', 'no gate', 'no distinct judge', 'the builder', 'skipped, with your reason', '—'];
    for (const c of Array.from(document.querySelectorAll<HTMLElement>('.rcx-s'))) {
      const old = c.textContent;
      for (const v of VALS) {
        c.textContent = v;
        const td = c.closest('td')!;
        if (over(c) || c.getBoundingClientRect().height > td.getBoundingClientRect().height + 0.5) bad.push(`receipt status "${v}"`);
      }
      c.textContent = old;
    }
    const st = document.querySelector<HTMLElement>('[data-wf-status]')!;
    const old = st.innerHTML;
    for (const p of Array.from(document.querySelectorAll<HTMLElement>('[data-wf-panel]'))) {
      const single = p.classList.contains('is-single');
      const tab = document.querySelector(`[data-wf-tab="${p.dataset.wfPanel}"]`)!.textContent!.trim();
      const ns = Array.from(p.querySelectorAll('.wf-s')).map((n) => (single ? tab : n.textContent!));
      ns.forEach((l, j) => {
        for (const html of [
          (single ? 'running · ' : `step ${j + 1} of ${ns.length} · `) + `<b>${l}</b>`,
          `<span class="deny">— daemon killed mid-job —</span> at <b>${l}</b>`,
          `<span class="ctrl">run.resumed {via: boot}</span> · re-entering <b>${l}</b>`,
        ]) {
          st.innerHTML = html;
          if (over(st)) bad.push(`status line "${st.textContent}"`);
        }
      });
    }
    st.innerHTML = old;
    const ct = document.querySelector<HTMLElement>('[data-caption-t]')!;
    const cap = document.querySelector<HTMLElement>('[data-caption]')!;
    const oc = ct.textContent;
    for (const c of ['You confirm the plan (this job runs phased, one gate per step).', 'The daemon is down. The job is still on disk, at the step it was on.', 'Resumed at the step it was on; finished steps stay finished.']) {
      ct.textContent = c;
      if (over(ct) || over(cap)) bad.push(`caption "${c}"`);
    }
    ct.textContent = oc;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-frame] *'))) {
      if (getComputedStyle(el).textOverflow === 'ellipsis' && el.getBoundingClientRect().width > 0 && el.scrollWidth > el.clientWidth + 1) bad.push(`cut: "${(el.textContent || '').trim()}"`);
    }
    return bad;
  });
}

for (const vp of [{ width: 1440, height: 700 }, { width: 1920, height: 1080 }, { width: 1024, height: 700 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 360, height: 740 }]) {
  test(`no state text is cut off in its box @ ${vp.width}x${vp.height}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/');
    await page.evaluate(async () => { await document.fonts.ready; });
    expect(await cutStates(page)).toEqual([]);
  });
}

test.describe('the hero log never holds the wheel', () => {
  for (const vp of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
    test(`a wheel notch over the log scrolls the page @ ${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto('/');
      await page.waitForTimeout(400);
      const log = page.locator('[data-log]');
      expect(await log.evaluate((el) => getComputedStyle(el).overflowY)).toBe('hidden');
      const b = (await log.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 60));
      await page.mouse.wheel(0, 100);
      expect(await settled(page), 'the wheel over the log did not move the page').toBeGreaterThan(100);
    });
  }
});

test.describe('the job demo, replayed', () => {
  test.use({ viewport: { width: 1440, height: 700 } });

  test('a replay starts from an empty log: nothing of the previous run stays, dimmed or not', async ({ page }) => {
    await page.goto('/');
    const job = page.locator('[data-job]');
    // (the poster itself is checked under reduced motion, where no replay can race the read)
    // the replay starts on its own when the card is in view (its first beat's caption), from an empty log
    await expect(job.locator('[data-caption]')).toContainText('You confirm the plan', { timeout: 10_000 });
    const texts = await job.locator('.ln').allTextContents();
    expect(texts.length, texts.join(' | ')).toBeLessThanOrEqual(3);
    expect(texts[0]).toContain('run.launched');
    expect(texts.join('\n')).not.toContain('evidence bundle ready');
    expect(texts.join('\n')).not.toContain('pull request #42');
    expect(await job.locator('.ln--ghost').count()).toBe(0);
    // and no line is drawn dimmed once its own fade-in is over
    const ops = await job.locator('.ln:not([hidden])').evaluateAll((ls) => ls.map((l) => { l.getAnimations().forEach((a) => a.finish()); return getComputedStyle(l).opacity; }));
    for (const op of ops) expect(op).toBe('1');
  });
});

/** The log's window at rest (no glide running): its shown lines, their type, the space between them,
 *  and whether each is whole. */
async function logWindow(page: Page) {
  return page.locator('[data-log]').evaluate((log) => new Promise<{ n: number; all: number; gaps: number[]; cut: (string | null)[]; roomForMore: boolean; font: number; lh: number; last: string | null }>((resolve) => {
    const resting = () => !log.getAnimations({ subtree: true }).some((a) => a.playState === 'running' && !(a instanceof CSSAnimation));
    (function wait() { if (resting()) resolve(measure()); else requestAnimationFrame(wait); })();
    function measure() {
    const box = log.getBoundingClientRect();
    const shown = Array.from(log.querySelectorAll<HTMLElement>('.ln')).filter((l) => !l.hidden && l.getBoundingClientRect().height > 0);
    const gaps = shown.slice(1).map((l, k) => Math.round(l.getBoundingClientRect().top - shown[k].getBoundingClientRect().bottom));
    const cut = shown.filter((l) => { const r = l.getBoundingClientRect(); return r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5; }).map((l) => l.textContent);
    const cs = shown.length ? getComputedStyle(shown[0]) : null;
    // under-filled: the line just above the window would still fit if it were shown (at most five)
    const all = Array.from(log.querySelectorAll<HTMLElement>('.ln')); const f = shown.length ? all.indexOf(shown[0]) : -1;
    let roomForMore = false;
    if (f > 0 && shown.length < 5) {
      const prev = all[f - 1]; prev.hidden = false;
      const last = shown[shown.length - 1], r = last.getBoundingClientRect();
      roomForMore = r.bottom <= box.bottom - parseFloat(getComputedStyle(log).paddingBottom) + 1;
      prev.hidden = true;
    }
    return { n: shown.length, all: log.querySelectorAll('.ln').length, gaps, cut, roomForMore, font: cs ? parseFloat(cs.fontSize) : 0, lh: cs ? parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) : 0, last: shown.length ? shown[shown.length - 1].textContent : '' };
    }
  }));
}

test.describe('the job log is a short window, not a wall of text', () => {
  for (const vp of [{ width: 1440, height: 700 }, { width: 1280, height: 660 }, { width: 1920, height: 1080 }, { width: 1024, height: 700 }]) {
    test(`at most five whole lines, 16px or larger, 12px apart, as the job runs @ ${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto('/');
      await page.evaluate(async () => { await document.fonts.ready; });
      const job = page.locator('[data-job]');
      for (const at of ['Claude Code builds it', 'Codex, a different agent', 'QE acceptance decides']) {
        await expect(job.locator('[data-caption]')).toContainText(at, { timeout: 20_000 });
        await page.waitForTimeout(350);
        const w = await logWindow(page);
        expect(w.n, `${at}: ${w.n} lines shown`).toBeGreaterThanOrEqual(1);
        expect(w.n, `${at}: ${w.n} lines shown`).toBeLessThanOrEqual(5);
        expect(w.cut, `${at}: lines cut by the log's edge`).toEqual([]);
        // codex (review r4): a refit during a glide counted the glide's offset and hid one line too many
        expect(w.roomForMore, `${at}: the window hides a line it has room for`).toBe(false);
        expect(w.font).toBeGreaterThanOrEqual(16);
        expect(w.lh).toBeGreaterThanOrEqual(1.45);
        for (const g of w.gaps) expect(g, `${at}: the space between lines`).toBeGreaterThanOrEqual(11);
      }
    });

    test(`the poster is the end of the job, in whole lines @ ${vp.width}x${vp.height}`, async ({ page }) => {
      // reduced motion keeps the poster (no replay can race the read)
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize(vp);
      await page.goto('/');
      await page.evaluate(async () => { await document.fonts.ready; });
      const w = await logWindow(page);
      expect(w.n).toBeGreaterThanOrEqual(3);
      expect(w.n).toBeLessThanOrEqual(5);
      expect(w.cut).toEqual([]);
      expect(w.last).toContain('evidence bundle ready');
    });
  }

  // CI (Linux): the poster was fitted before the web font arrived; with it the lines wrapped longer and
  // the last one hung past the log's bottom edge, since the log's own box never changed size. Any
  // rewrap (a late font, text spacing, a user style) must refit the window. Here the lines are made
  // wider after the poster is fitted.
  test('lines that rewrap after the window is fitted are refitted: they stay whole', async ({ page }) => {
    // and the refit raises no ResizeObserver loop error (it runs on the next frame, not inside delivery)
    await page.addInitScript(() => { (window as unknown as { __errs: string[] }).__errs = []; window.addEventListener('error', (e) => (window as unknown as { __errs: string[] }).__errs.push(e.message)); });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.evaluate(async () => { await document.fonts.ready; });
    expect((await logWindow(page)).cut).toEqual([]);
    await page.addStyleTag({ content: '[data-log] .ln { letter-spacing: .12em; }' });
    await page.waitForTimeout(200);
    const w = await logWindow(page);
    expect(w.cut).toEqual([]);
    expect(w.roomForMore).toBe(false);
    expect(w.n).toBeGreaterThanOrEqual(1);
    expect(w.last).toContain('evidence bundle ready');
    expect(await page.evaluate(() => (window as unknown as { __errs: string[] }).__errs)).toEqual([]);
  });

  // codex (review r5): a line hidden by the window is display: none, so no observer sees it rewrap.
  // When only it narrows (here: spacing that wrapped it alone is taken away), the window stays a line
  // short until something refits it; a web font arriving (now or later) refits from scratch.
  test('a font that arrives later refits a window whose hidden line narrowed', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.evaluate(async () => { await document.fonts.ready; });
    const tag = await page.addStyleTag({ content: '[data-log] .ln { letter-spacing: .02em; }' });
    await page.waitForTimeout(200);
    await tag.evaluate((el) => el.remove());
    await page.waitForTimeout(200);
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /jetbrains-mono-latin-wght-normal/.test(n))!;
      const face = new FontFace('Refit Probe', `url(${url})`);
      document.fonts.add(face);
      await face.load();
    });
    await page.waitForTimeout(200);
    const w = await logWindow(page);
    expect(w.cut).toEqual([]);
    expect(w.roomForMore, 'the window stayed a line short').toBe(false);
  });

  // codex (local review): the lines still shown glided up while the new one appeared at its place, so
  // for a moment they were drawn over it, text on text again. Every frame of the moving window counts.
  for (const vp of [{ width: 1440, height: 700 }, { width: 390, height: 844 }]) {
    test(`as the window moves, no line ever passes over another @ ${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto('/');
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.locator('[data-log]').scrollIntoViewIfNeeded();
      // the window is full by the build step; sample every frame across the next lines
      await expect(page.locator('[data-caption]')).toContainText('Claude Code builds it', { timeout: 20_000 });
      const over = await page.evaluate(() => new Promise<string[]>((resolve) => {
        const log = document.querySelector('[data-log]')!; const bad: string[] = []; const t0 = performance.now(); let moved = 0;
        (function frame() {
          const ls = Array.from(log.querySelectorAll<HTMLElement>('.ln')).filter((l) => !l.hidden);
          // the glide is a script animation (the line's own fade-in is a CSS one)
          if (ls.some((l) => l.getAnimations().some((a) => a.playState === 'running' && !(a instanceof CSSAnimation)))) moved++;
          for (let k = 1; k < ls.length; k++) {
            const a = ls[k - 1].getBoundingClientRect(), b = ls[k].getBoundingClientRect();
            if (b.top < a.bottom - 1) bad.push(`${Math.round(a.bottom - b.top)}px over "${(ls[k].textContent || '').slice(0, 30)}"`);
          }
          if (performance.now() - t0 < 4500) requestAnimationFrame(frame); else resolve(moved ? bad : ['the window never moved']);
        })();
      }));
      expect(over).toEqual([]);
    });
  }

  test('reduced motion switched on mid-glide lands the lines at once', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    // every animation at 1/20 speed, so the 260ms glide is still running when the preference flips
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.05 });
    const glides = () => page.locator('[data-log]').evaluate((log) => log.getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && !(a instanceof CSSAnimation)).length);
    await expect.poll(glides, { timeout: 20_000, intervals: [100] }).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(glides, { timeout: 1_000, intervals: [50] }).toBe(0);
  });

  test('a restart adds two lines at once; reduced motion switched on then lands every line, none over another', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const job = page.locator('[data-job]');
    await expect(job.locator('[data-caption]')).toContainText('Claude Code builds it', { timeout: 20_000 });
    await job.getByRole('button', { name: 'Kill the daemon' }).click();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.05 });
    await job.getByRole('button', { name: 'Start the daemon' }).click();
    const glides = () => page.locator('[data-log]').evaluate((log) => log.getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && !(a instanceof CSSAnimation)).length);
    await expect.poll(glides, { timeout: 5_000, intervals: [50] }).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(glides, { timeout: 1_000, intervals: [50] }).toBe(0);
    const over = await page.locator('[data-log]').evaluate((log) => {
      const ls = Array.from(log.querySelectorAll<HTMLElement>('.ln')).filter((l) => !l.hidden); const bad: string[] = [];
      for (let k = 1; k < ls.length; k++) { const a = ls[k - 1].getBoundingClientRect(), b = ls[k].getBoundingClientRect(); if (b.top < a.bottom - 1) bad.push((ls[k].textContent || '').slice(0, 30)); }
      return bad;
    });
    expect(over).toEqual([]);
  });

  test('on a phone the ticker shows the newest whole lines in the same 16px type, 12px apart', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.evaluate(async () => { await document.fonts.ready; });
    const w = await logWindow(page);
    expect(w.n).toBeGreaterThanOrEqual(1);
    expect(w.n).toBeLessThanOrEqual(5);
    expect(w.cut).toEqual([]);
    expect(w.font).toBeGreaterThanOrEqual(16);
    expect(w.lh).toBeGreaterThanOrEqual(1.45);
    for (const g of w.gaps) expect(g).toBeGreaterThanOrEqual(11);
    expect(w.last).toContain('evidence bundle ready');
  });
});

/* wicked-core main (ca903459) src/presets/editor-plugin.json, its steps' ids in order */
const EDITOR_PLUGIN_STEPS = ['scope', 'design', 'build', 'test', 'security-review', 'install-plan', 'install'];

test.describe('the built-in workflows', () => {
  test.use({ viewport: { width: 1440, height: 700 } });

  test('editor-plugin\'s rail is exactly the preset\'s steps; mcp-server is one line (its nine steps do not fit)', async ({ page }) => {
    await page.goto('/');
    const panel = (name: string) => page.locator('[data-wf-panel]').nth(
      ['feature', 'bug', 'migration', 'mcp-server', 'editor-plugin', 'domain-extraction'].indexOf(name));
    expect(await panel('editor-plugin').locator('.wf-s').allTextContents()).toEqual(EDITOR_PLUGIN_STEPS);
    await expect(panel('mcp-server')).toHaveClass(/is-single/);
    expect(await panel('mcp-server').locator('.wf-s').allTextContents()).toEqual(['build an MCP server, install it on consent']);
  });
});

test.describe('arrival', () => {
  test.use({ viewport: { width: 1440, height: 700 } });

  test('reduced motion switched on after load shows every frame at once, with no rise', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(300);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => document.getElementById('build')!.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.waitForTimeout(80);
    const h2 = page.locator('#sandbox-h');
    expect(await h2.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    expect(await h2.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });

  test('reduced motion switched on after load shows the install command whole (no typing)', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(300);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => document.getElementById('get')!.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.waitForTimeout(150);
    const t = page.locator('[data-type]');
    expect(await t.evaluate((el) => getComputedStyle(el).clipPath)).toBe('none');
    expect(await t.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });

  test('reduced motion switched on mid-visit: no queued replay, still cards, a finished workflow', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(250);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // the hero replay was queued (1.6s after the card is in view): it never starts on its own
    await page.waitForTimeout(2500);
    await expect(page.locator('[data-panel]')).toContainText('DELIVERED');
    // the workflow ticker that was running stops at the finished job
    await page.evaluate(() => document.getElementById('deliver')!.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await expect(page.locator('[data-wf-status]')).toContainText('done', { timeout: 3000 });
    // What's new: the cards are simply there
    await page.evaluate(() => document.getElementById('news')!.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.waitForTimeout(120);
    const li = page.locator('.news-list li').last();
    expect(await li.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    expect(await li.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  });

  test('with motion, a frame rises in once it arrives, and is fully shown after', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('gate')!.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await expect(page.locator('#gate')).toHaveClass(/is-arrived/);
    await page.waitForTimeout(1400);
    for (const sel of ['#gates-h', '#gate .rcx', '#gate .benefit']) {
      expect(await page.locator(sel).evaluate((el) => getComputedStyle(el).opacity), sel).toBe('1');
    }
  });
});

test.describe('the thread', () => {
  test.use({ viewport: { width: 1440, height: 700 } });

  test('fills one beat per frame and never covers the topbar', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(300);
    const fills = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-thread-seg] b')).map((b) => Number(getComputedStyle(b).getPropertyValue('--f') || 0)));
    expect((await fills())[0]).toBeGreaterThan(0.95);
    expect((await fills())[1]).toBeLessThan(0.05);
    const tb = await page.evaluate(() => {
      const t = document.querySelector('[data-thread]')!.getBoundingClientRect();
      return { top: t.top, bar: document.querySelector('.topbar')!.getBoundingClientRect().bottom, z: getComputedStyle(document.querySelector('[data-thread]')!).zIndex };
    });
    expect(tb.top).toBeGreaterThanOrEqual(tb.bar - 0.5);
    expect(Number(tb.z)).toBeLessThan(200);
    await page.evaluate(() => document.getElementById('gate')!.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.waitForTimeout(300);
    const f = await fills();
    expect(f.slice(0, 4).every((v) => v > 0.95), `fills at Gate: ${f}`).toBe(true);
    expect(f[4]).toBeLessThan(0.05);
  });
});

test.describe('the job track', () => {
  for (const vp of [{ width: 768, height: 1024 }, { width: 1024, height: 700 }, { width: 1100, height: 700 }, { width: 390, height: 844 }, { width: 360, height: 740 }]) {
    test(`every gate stays inside its phase, and both ends keep their legends @ ${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto('/');
      await page.evaluate(async () => { await document.fonts.ready; });
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        document.querySelectorAll('.st').forEach((st, i) => {
          const r = st.getBoundingClientRect();
          for (const c of Array.from(st.children)) {
            const q = c.getBoundingClientRect();
            if (q.right > r.right + 0.5 || q.left < r.left - 0.5) out.push(`phase ${i}: ${c.className} spills ${Math.round(q.right - r.right)}px`);
          }
        });
        document.querySelectorAll<HTMLElement>('.io').forEach((io) => {
          const r = io.getBoundingClientRect();
          const sm = io.querySelector('small')!.getBoundingClientRect();
          if (io.scrollWidth > io.clientWidth + 1 || io.scrollHeight > io.clientHeight + 1) out.push(`overflow: ${io.textContent!.trim()}`);
          if (sm.right > r.right + 0.5) out.push(`legend cut: ${io.textContent!.trim()}`);
        });
        return out;
      });
      expect(bad).toEqual([]);
    });
  }
});
