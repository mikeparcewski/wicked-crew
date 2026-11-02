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
 */

async function settled(page: Page) {
  let last = -1;
  for (let k = 0; k < 30; k++) {
    await page.waitForTimeout(120);
    const y = await page.evaluate(() => Math.round(window.scrollY));
    if (y === last) return y;
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

for (const vp of [{ width: 1440, height: 700 }, { width: 1920, height: 1080 }, { width: 1024, height: 700 }, { width: 390, height: 844 }, { width: 360, height: 740 }]) {
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

  test('a replay keeps the log full: the previous lines dim and the new ones replace them', async ({ page }) => {
    await page.goto('/');
    const job = page.locator('[data-job]');
    const lines = () => job.locator('.ln').count();
    const n0 = await lines();
    expect(n0).toBeGreaterThan(15);
    // the replay starts on its own when the card is in view; a moment in, the box is still full
    await expect(job.locator('[data-caption]')).toContainText('Claude Code builds it', { timeout: 10_000 });
    expect(await lines()).toBe(n0);
    expect(await job.locator('.ln--ghost').count()).toBeGreaterThan(0);
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
