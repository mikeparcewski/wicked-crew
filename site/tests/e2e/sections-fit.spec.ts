import { test, expect } from '@playwright/test';

/**
 * Every section fits a laptop viewport (crew#337).
 *
 * The page pairs a fixed 64px topbar with per-section
 * `min-height: calc(100svh - var(--topbar-h))` and `scroll-snap-align: start`,
 * so a section actually gets the viewport MINUS the topbar. Measured at
 * 1440x700 before this spec existed, five sections overflowed that usable
 * band: hero +30, skins +44, byo +62, console-sec +168, get +11.
 *
 * Two measurement rules, learned in wicked-studio #133/#134
 * (site/tests/e2e/hero-fits.spec.ts there is the reference implementation):
 *
 *  - Measure CONTENT height (padding + in-flow children + their margins), not
 *    the section box. The box is clamped by `min-height`, so it reports
 *    "fits, 0px spare" right up until it doesn't — #335 shipped on exactly
 *    that misreading.
 *  - Measure usable height from the live topbar, not a hardcoded 64: a token
 *    change must not silently loosen the assertion.
 *
 * CI's Linux runner renders these pages ~24px taller than macOS. The spec
 * asserts the honest bound (content <= usable); the layout keeps >=20px of
 * local slack per section so the Linux delta cannot tip a passing section
 * over the line.
 */

const VIEWPORTS = [
  { width: 1440, height: 700 },
  { width: 1440, height: 760 },
];

/** Selectors for everything that behaves as a full-viewport snap slide. */
const SLIDES = 'section, .same-garden';

async function usableHeight(page: import('@playwright/test').Page, vpHeight: number) {
  return (
    vpHeight -
    (await page.evaluate(() => {
      const bar = document.querySelector('.topbar, header[class*="topbar"]');
      return bar ? Math.round(bar.getBoundingClientRect().height) : 0;
    }))
  );
}

/** Content height per slide: padding + in-flow children + their margins. */
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
        name: String((el as HTMLElement).className).split(' ')[0] || el.tagName.toLowerCase(),
        content: Math.round(content),
      };
    });
  }, selector);
}

for (const vp of VIEWPORTS) {
  test.describe(`sections fit ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('every section’s content fits the usable viewport', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.waitForTimeout(400);

      const usable = await usableHeight(page, vp.height);
      const over = (await contentHeights(page, SLIDES)).filter((s) => s.content > usable);
      expect(
        over,
        `section content taller than ${usable}px of usable height: ` +
          over.map((s) => `${s.name}=${s.content}`).join(', '),
      ).toEqual([]);
    });

    test('the hero still fits once the studio mock raises its gate', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(async () => { await document.fonts.ready; });
      // The mock auto-plays on load; the gate is the layout-changing state —
      // an uncapped gate column once stretched the console row +42px.
      await page.waitForSelector('[data-studio-gate]:not([hidden])', { timeout: 25_000 });
      await page.waitForTimeout(300);

      const usable = await usableHeight(page, vp.height);
      const hero = (await contentHeights(page, '.hero'))[0];
      expect(
        hero.content,
        `.hero content is ${hero.content}px in ${usable}px of usable height with the gate raised`,
      ).toBeLessThanOrEqual(usable);

      // And the decision itself is on screen — the gate is the hero's argument.
      for (const action of ['approve', 'steer', 'reject']) {
        const bottom = await page
          .locator(`[data-sg-action="${action}"]`)
          .evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
        expect(
          bottom,
          `the "${action}" control ends ${bottom}px down a ${vp.height}px window`,
        ).toBeLessThanOrEqual(vp.height);
      }
    });
  });
}
