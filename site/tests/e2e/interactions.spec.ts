import { test, expect, type Page } from '@playwright/test';

/**
 * Interactions never cause page display issues (the operator's criterion 6).
 *
 * The defect class: a hover, focus, tap or animated state that grows, moves, covers or pushes into
 * a neighbour or the next section (the garden site's bottom-row cards slid under the text below).
 * crew's rule is SWAP, DON'T GROW: every interactive region is a fixed box sized for its tallest
 * state, with every state stacked in one grid cell, so a state change only crossfades inside it.
 *
 * For every control in each of crew's frames this hovers it, focuses it and (buttons) clicks it, and
 * after each step compares the document-space box of every element in the frame and the next one.
 * Nothing outside the control may move or resize by more than 1.5px; the control itself may lift
 * by 3px or less. The contents of a swap box (.stack items, the log, the receipt panel, a status
 * line) change by design and are not compared; the boxes themselves are. Reduced motion keeps the
 * autoplays still, so only the interaction is measured; the animated states have their own checks.
 */

const FRAMES = ['job', 'build', 'review', 'gate', 'deliver', 'news', 'get'];

async function setup(page: Page, frame: string) {
  return page.evaluate((id) => {
    const sec = document.getElementById(id)!;
    let next = sec.nextElementSibling as HTMLElement | null;
    while (next && !next.getBoundingClientRect().height) next = next.nextElementSibling as HTMLElement | null;
    if (!next && sec.parentElement) next = sec.parentElement.nextElementSibling as HTMLElement | null;
    for (const e of document.querySelectorAll('[data-ix]')) e.removeAttribute('data-ix');
    let n = 0;
    for (const s of [sec, next]) if (s) for (const e of [s, ...s.querySelectorAll('*')]) e.setAttribute('data-ix', String(n++));
    const ctrls = Array.from(sec.querySelectorAll<HTMLElement>('button, a[href], [data-hot]'))
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })
      .filter((e) => !e.closest('[aria-hidden="true"]'));
    return ctrls.map((e) => ({ ix: e.getAttribute('data-ix')!, tag: e.tagName, href: e.getAttribute('href'), name: (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32) }));
  }, frame);
}

/** Boxes in document space; the contents of swap boxes are skipped (the boxes are kept). */
async function snap(page: Page) {
  return page.evaluate(() => {
    // .news-list * : on a phone it is a carousel, whose slides move inside its own box by design
    const SKIP = '.stack > *, .stack > * *, .log *, [data-panel] *, [data-wf-status] *, [data-caption] *, [data-sbx-agent], .rcx-s, .news-list *';
    const out: Record<string, number[]> = {};
    for (const e of document.querySelectorAll<HTMLElement>('[data-ix]')) {
      if (e.matches(SKIP)) continue;
      const r = e.getBoundingClientRect();
      out[e.getAttribute('data-ix')!] = [r.left + scrollX, r.top + scrollY, r.width, r.height];
      (window as any).__ixName = (window as any).__ixName || {};
      (window as any).__ixName[e.getAttribute('data-ix')!] = e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '');
    }
    return out;
  });
}

function diff(a: Record<string, number[]>, b: Record<string, number[]>, self: string, selfSub: Set<string>) {
  const bad: string[] = [];
  for (const id in b) {
    if (!a[id]) continue;
    const d = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(a[id][k] - b[id][k])));
    if (id === self) { if (d > 3.5) bad.push(`the control itself moved/resized by ${d.toFixed(1)}px`); continue; }
    if (selfSub.has(id)) continue;
    if (d > 1.5) bad.push(`#${id} moved/resized by ${d.toFixed(1)}px`);
  }
  return bad;
}

for (const vp of [{ width: 1440, height: 700 }, { width: 390, height: 844 }]) {
  test.describe(`criterion 6 @ ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp, contextOptions: { reducedMotion: 'reduce' }, hasTouch: vp.width < 600 });

    for (const frame of FRAMES) {
      test(`no control in #${frame} moves, grows or pushes anything else`, async ({ page }) => {
        await page.goto('/');
        await page.evaluate(async () => { await document.fonts.ready; });
        const ctrls = await setup(page, frame);
        // What's new has controls only on a phone (its carousel)
        test.skip(ctrls.length === 0 && frame === 'news', 'no controls at this size');
        expect(ctrls.length, `no controls found in #${frame}`).toBeGreaterThan(0);
        const problems: string[] = [];
        for (const c of ctrls) {
          const loc = page.locator(`[data-ix="${c.ix}"]`);
          await loc.evaluate((el) => el.scrollIntoView({ block: 'center' }));
          await page.mouse.move(1, vp.height - 1);
          await page.waitForTimeout(60);
          const sub = new Set(await loc.evaluate((el) => [...el.querySelectorAll('[data-ix]')].map((e) => e.getAttribute('data-ix')!)));
          let before = await snap(page);
          const box = (await loc.boundingBox())!;
          const steps: [string, () => Promise<void>][] = [
            ['hover', () => page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)],
            ['focus', () => loc.focus()],
          ];
          // a click that navigates (a link) or replays the whole demo (Run) is not a state of this box
          if (c.tag === 'BUTTON' && !(await loc.evaluate((e) => e.hasAttribute('data-job-run'))) && (await loc.getAttribute('aria-disabled')) !== 'true') {
            steps.push(['click', () => loc.click({ force: true, noWaitAfter: true })]);
          }
          for (const [what, act] of steps) {
            await act();
            await page.waitForTimeout(260);
            const after = await snap(page);
            const names = await page.evaluate(() => (window as any).__ixName || {});
            for (const p of diff(before, after, c.ix, sub)) problems.push(`${what} "${c.name}": ${p.replace(/#(\d+)/, (m, id) => `${m} ${names[id] || ''}`)}`);
            before = after;
          }
          await loc.evaluate((el) => (el as HTMLElement).blur());
        }
        expect(problems.slice(0, 12), problems.length ? `${problems.length} display problems in #${frame}` : '').toEqual([]);
      });
    }

    test('every focus stop shows a ring and is never under the topbar', async ({ page }) => {
      await page.goto('/');
      const bad: string[] = [];
      const seen = new Set<string>();
      for (let k = 0; k < 90; k++) {
        await page.keyboard.press('Tab');
        const f = await page.evaluate(() => {
          const e = document.activeElement as HTMLElement | null;
          if (!e || e === document.body) return null;
          const id = e.getAttribute('data-f') || String(Math.random());
          e.setAttribute('data-f', id);
          const r = e.getBoundingClientRect();
          const c = getComputedStyle(e);
          const tb = document.querySelector('.topbar')!;
          const inTb = tb.contains(e);
          const ring = (c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0) || (c.boxShadow !== 'none');
          return { id, crew: !!e.closest('[data-frame]'), name: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30), ring, under: !inTb && r.top < tb.getBoundingClientRect().bottom - 2, inView: r.bottom > 0 && r.top < innerHeight };
        });
        if (!f) continue;
        if (seen.has(f.id)) break;
        seen.add(f.id);
        if (!f.crew) continue;
        if (!f.ring) bad.push(`no focus ring: ${f.name}`);
        if (f.under) bad.push(`under the topbar: ${f.name}`);
        if (!f.inView) bad.push(`off screen: ${f.name}`);
      }
      expect(seen.size).toBeGreaterThan(20);
      expect(bad).toEqual([]);
    });
  });
}

test.describe('animated states never move anything outside their box', () => {
  test.use({ viewport: { width: 1440, height: 700 } });

  test('the hero is one height through the whole demo, and the autoplays move nothing', async ({ page }) => {
    test.setTimeout(75_000);
    await page.goto('/');
    await page.evaluate(async () => { await document.fonts.ready; });
    const heroH = () => page.evaluate(() => Math.round(document.querySelector('.hero')!.getBoundingClientRect().height));
    const h0 = await heroH();
    const job = page.locator('[data-job]');
    await expect(job.locator('[data-caption]')).toContainText('Claude Code builds it', { timeout: 10_000 });
    expect(await heroH()).toBe(h0);
    await expect(job.locator('[data-qe="CONDITIONAL"]')).toBeVisible({ timeout: 30_000 });
    expect(await heroH()).toBe(h0);
    await job.locator('[data-qe="CONDITIONAL"]').click();
    expect(await heroH()).toBe(h0);

    // the Review, Gate and Deliver autoplays: sample their frames while they run
    for (const frame of ['review', 'gate', 'deliver']) {
      await setup(page, frame);
      await page.locator(`#${frame}`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(300);
      const first = await snap(page);
      for (let k = 0; k < 4; k++) {
        await page.waitForTimeout(900);
        const now = await snap(page);
        const moved = diff(first, now, '-', new Set());
        expect(moved, `#${frame} autoplay moved its layout`).toEqual([]);
      }
    }
  });
});
