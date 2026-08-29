import { test, expect } from '@playwright/test';

/**
 * Scroll-snap reachability.
 *
 * The site used to set `scroll-snap-type: y mandatory`, overriding the shared
 * chrome's `y proximity`. Under `mandatory` the viewport may not come to rest
 * anywhere that is not a snap point, so:
 *   - any section taller than the viewport had its lower half made unreachable;
 *   - at 1440x760 the page did not scroll at all — from the top, one 320px wheel
 *     notch landed nearer the hero's snap point than the next section's, so the
 *     browser dragged the viewport straight back to y=0. Three notches, scrollY
 *     never left 0, eleven of twelve sections unreachable by mouse.
 * Same defect and same fix as wicked-studio#132.
 *
 * These tests drive the page with REAL wheel events (page.mouse.wheel). That is
 * load-bearing: window.scrollBy() emits no wheel event and bypasses the snap
 * machinery entirely, so it passes happily on a page that is frozen in the hand.
 */

/** Every section that must be reachable, in document order. */
const SECTIONS = [
  'hero', 'probs', 'studio', 'skins', 'byo', 'console-sec',
  'wf', 'rail-sec', 'council', 'same-garden', 'get', 'footer',
];

const VIEWPORTS = [
  { w: 1440, h: 700 },
  { w: 1440, h: 760 },
];

test.describe('scroll-snap reachability', () => {
  for (const vp of VIEWPORTS) {
    test(`snap is soft and every section has a snap point @ ${vp.w}x${vp.h}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto('/');

      // `y proximity` serializes to `y` (proximity is the initial strictness).
      // The assertion that matters is that it is NOT mandatory.
      const snapType = await page.evaluate(
        () => getComputedStyle(document.documentElement).scrollSnapType,
      );
      expect(snapType).not.toContain('mandatory');
      expect(snapType).toBe('y');

      // DEFECT 2: a section with scroll-snap-align:none is scrolled straight
      // past. Snap points are assigned structurally now, so enumerate the DOM
      // rather than a hardcoded list — a section added later is covered too.
      const noSnap = await page.evaluate(() =>
        Array.from(document.querySelectorAll('section'))
          .filter((el) => getComputedStyle(el).scrollSnapAlign === 'none')
          .map((el) => String(el.className).split(' ')[0] || el.tagName),
      );
      expect(noSnap).toEqual([]);
    });

    test(`mouse wheel reaches every section @ ${vp.w}x${vp.h}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto('/');
      await page.waitForTimeout(600);

      await page.evaluate(() => {
        (window as any).__ends = 0;
        window.addEventListener('scrollend', () => { (window as any).__ends++; });
      });
      await page.mouse.move(vp.w / 2, vp.h / 2);

      const seen = new Set<string>();
      let lastY = -1;
      let stuck = 0;

      for (let step = 0; step < 80; step++) {
        const n = await page.evaluate(() => (window as any).__ends);
        await page.mouse.wheel(0, 320);
        // Wait for the scroll to settle (incl. any snap correction) before reading.
        await page
          .waitForFunction((prev) => (window as any).__ends > prev, n, { timeout: 1200 })
          .catch(() => {});
        await page.waitForTimeout(110);

        const cur = await page.evaluate((vh) => {
          const els = Array.from(document.querySelectorAll('section, .same-garden, .footer'));
          let best = '';
          let bestVis = -1;
          for (const el of els) {
            const r = el.getBoundingClientRect();
            const vis = Math.min(r.bottom, vh) - Math.max(r.top, 0);
            if (vis > bestVis) { bestVis = vis; best = String((el as HTMLElement).className).split(' ')[0]; }
          }
          return {
            y: Math.round(window.scrollY),
            best,
            atEnd: Math.ceil(window.scrollY + window.innerHeight)
              >= document.documentElement.scrollHeight - 2,
          };
        }, vp.h);

        seen.add(cur.best);

        // Under the old `mandatory` this tripped at y=0 on the third notch.
        if (cur.y === lastY) {
          stuck++;
          expect(stuck, `wheel made no progress — stuck at scrollY=${cur.y} after ${step} notches`).toBeLessThan(3);
        } else {
          stuck = 0;
        }
        lastY = cur.y;
        if (cur.atEnd) break;
      }

      const missed = SECTIONS.filter((s) => !seen.has(s));
      expect(missed, `sections never reachable by mouse wheel: ${missed.join(', ')}`).toEqual([]);
    });
  }

  test('no section overflows the viewport by more than a wheel notch @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(600);

    const tall = await page.evaluate(() =>
      Array.from(document.querySelectorAll('section, .same-garden, .footer'))
        .map((el) => ({
          name: String((el as HTMLElement).className).split(' ')[0],
          h: Math.round(el.getBoundingClientRect().height),
        }))
        .filter((s) => s.h > window.innerHeight),
    );

    // No exceptions — crew#337 recovered even .console-sec (was 804px) from
    // type, spacing and copy without squashing the gate console. The stronger
    // content-vs-usable-height guard lives in sections-fit.spec.ts; this one
    // keeps the coarse box-vs-viewport regression net.
    expect(
      tall,
      `sections taller than the 700px viewport: ${tall.map((s) => `${s.name}=${s.h}`).join(', ')}`,
    ).toEqual([]);
  });

  test('the shared platform band fits a laptop viewport @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(600);

    // Regression guard on the re-pinned chrome: this band was 1115px (415px
    // past the fold) before wicked-web#28 brought it to ~686px.
    const h = await page.evaluate(
      () => Math.round(document.querySelector('.same-garden')!.getBoundingClientRect().height),
    );
    expect(h).toBeLessThanOrEqual(700);
    expect(h).toBeLessThan(760);
  });
});

test.describe('content is not truncated or orphaned', () => {
  test('install command blocks do not clip their trailing comment @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);

    // Was: scrollWidth 630 inside clientWidth 541 — "· ships the `wicked` CLI"
    // was cut off, reachable only by scrolling a code block sideways.
    const clipped = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.install__code')).
        map((el) => ({
          text: (el.textContent || '').trim().slice(0, 40),
          scrollW: (el as HTMLElement).scrollWidth,
          clientW: (el as HTMLElement).clientWidth,
        }))
        .filter((r) => r.scrollW > r.clientW + 1),
    );
    expect(clipped).toEqual([]);
  });

  test('the ToS call-to-action does not strand its arrow on its own line', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);

    // Was: 2 client rects, the second only 16px wide — a lone "→".
    const rects = await page.evaluate(() =>
      Array.from(document.querySelector('.get-tos a')!.getClientRects()).map((r) => Math.round(r.width)),
    );
    expect(rects.length).toBe(1);
    expect(rects[0]).toBeGreaterThan(40);
  });
});
