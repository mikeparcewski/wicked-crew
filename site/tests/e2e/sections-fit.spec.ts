import { test, expect } from '@playwright/test';

/**
 * Every frame fits a desktop window (crew#337), at the three desktop sizes, in both themes.
 *
 * Each frame (`[data-frame]`) is `min-height: calc(100svh - var(--topbar-h))` on a desktop window,
 * so it gets the viewport MINUS the fixed topbar. Two measurement rules, learned in wicked-studio
 * #133/#134:
 *
 *  - Measure CONTENT height (padding + in-flow children + their margins), not the section box. The
 *    box is clamped by `min-height`, so it reports "fits, 0px spare" right up until it doesn't.
 *  - Measure usable height from the live topbar, not a hardcoded 64.
 *
 * CI's Linux runner sets text about 4% wider than macOS, so the layout keeps 30px or more of local
 * slack per frame and this asserts the honest bound (content <= usable).
 *
 * At 1920x1080 the frames must not be sparse either: each proof frame fills at least 55% of the
 * usable height (the site's display scale grows with the window).
 */

const VIEWPORTS = [
  { width: 1440, height: 700 },
  { width: 1280, height: 660 },
  { width: 1920, height: 1080 },
];
const THEMES = ['dark', 'light'] as const;

/** Everything that behaves as a full-viewport frame: crew's own frames and the shared family band. */
const FRAMES = '[data-frame], .same-garden';

async function usableHeight(page: import('@playwright/test').Page, vpHeight: number) {
  return (
    vpHeight -
    (await page.evaluate(() => {
      const bar = document.querySelector('.topbar, header[class*="topbar"]');
      return bar ? Math.round(bar.getBoundingClientRect().height) : 0;
    }))
  );
}

/** Content height per frame: padding + in-flow children + their margins. */
async function contentHeights(page: import('@playwright/test').Page, selector: string) {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((el) => {
      const cs = getComputedStyle(el);
      let content = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      for (const ch of el.children) {
        const ccs = getComputedStyle(ch);
        if (ccs.position === 'absolute' || ccs.position === 'fixed' || ccs.display === 'none') continue;
        content +=
          ch.getBoundingClientRect().height +
          parseFloat(ccs.marginTop) +
          parseFloat(ccs.marginBottom);
      }
      return {
        name: el.id || String((el as HTMLElement).className).split(' ')[0] || el.tagName.toLowerCase(),
        content: Math.round(content),
      };
    });
  }, selector);
}

for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    test.describe(`frames fit ${vp.width}x${vp.height} (${theme})`, () => {
      test.use({ viewport: vp });
      test.beforeEach(async ({ page }) => {
        await page.addInitScript((t) => { try { localStorage.setItem('wa-theme-v3', t); } catch { /* private mode */ } }, theme);
      });

      test('every frame’s content fits the usable viewport', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(async () => { await document.fonts.ready; });
        await page.waitForTimeout(400);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

        const usable = await usableHeight(page, vp.height);
        const rows = await contentHeights(page, FRAMES);
        expect(rows.map((r) => r.name)).toEqual(['job', 'build', 'review', 'gate', 'deliver', 'news', 'same-garden', 'get']);
        const over = rows.filter((s) => s.content > usable);
        expect(
          over,
          `frame content taller than ${usable}px of usable height: ` + over.map((s) => `${s.name}=${s.content}`).join(', '),
        ).toEqual([]);

        if (vp.height >= 1000) {
          const sparse = rows
            .filter((r) => ['build', 'review', 'gate', 'deliver', 'news'].includes(r.name))
            .filter((r) => r.content < usable * 0.55);
          expect(sparse, `frames under 55% full at ${vp.width}x${vp.height}: ${sparse.map((s) => `${s.name}=${s.content}`).join(', ')}`).toEqual([]);
        }
      });
    });
  }
}

for (const vp of VIEWPORTS.slice(0, 2)) {
  test.describe(`the hero's decisions ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('the job demo’s decisions are on screen without scrolling', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(async () => { await document.fonts.ready; });
      const job = page.locator('[data-job]');
      // The job replays on its own and pauses for the QE verdict, the hero's tallest state.
      await expect(job.locator('[data-qe="PASS"]')).toBeVisible({ timeout: 30_000 });
      for (const sel of ['[data-job-kill]', '[data-qe="PASS"]', '[data-qe="CONDITIONAL"]', '[data-gate="4"]', '[data-pr]', '[data-caption]']) {
        await expect(job.locator(sel).first(), `${sel} is below the fold`).toBeInViewport({ ratio: 1 });
      }
      const usable = await usableHeight(page, vp.height);
      const hero = (await contentHeights(page, '.hero'))[0];
      expect(hero.content, `.hero content is ${hero.content}px in ${usable}px`).toBeLessThanOrEqual(usable);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });
  });
}
