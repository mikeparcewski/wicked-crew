import { test, expect, devices } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * Phones (390x844): the job demo is the same working demo, laid out for a phone (a short ticker and a
 * fixed receipt panel, so nothing grows while it runs). The explorables become tappable lists, What's
 * new is a carousel, the four-plane map renders, and the page never scrolls sideways.
 */
// iPhone 12 geometry/UA only: the full descriptor's defaultBrowserType would switch to WebKit.
const iphone12 = devices['iPhone 12'];
test.use({
  viewport: iphone12.viewport,
  userAgent: iphone12.userAgent,
  deviceScaleFactor: iphone12.deviceScaleFactor,
  isMobile: iphone12.isMobile,
  hasTouch: iphone12.hasTouch,
});

test.describe('mobile (390×844)', () => {
  test('the job demo runs to delivery on a phone', async ({ page }) => {
    await page.goto('/');
    const job = page.locator('[data-job]');
    await bringIntoView(job);
    await job.locator('[data-qe="PASS"]').click({ timeout: 30_000 });
    await expect(job.locator('.ln').last()).toContainText('evidence bundle ready', { timeout: 10_000 });
    await expect(job.locator('[data-gate="4"]')).toBeEnabled();
  });

  test('no horizontal overflow anywhere on the page', async ({ page }) => {
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('the demo card is laid out for a thumb: title first, Run and Kill side by side, 44px gate chips', async ({ page }) => {
    await page.goto('/');
    const job = page.locator('[data-job]');
    const title = await job.locator('.job-t').boundingBox();
    const run = await job.locator('[data-job-run]').boundingBox();
    const kill = await job.locator('[data-job-kill]').boundingBox();
    expect(title!.y).toBeLessThan(run!.y);
    expect(Math.abs(run!.y - kill!.y), 'Run and Kill are not on one row').toBeLessThanOrEqual(1);
    expect(Math.abs(run!.width - kill!.width)).toBeLessThanOrEqual(2);
    for (const k of [0, 1, 2, 3, 4]) {
      const g = await job.locator(`[data-gate="${k}"]`).boundingBox();
      expect(g!.height, `gate chip ${k} is under the 44px target size`).toBeGreaterThanOrEqual(44);
    }
  });

  test('the demo never changes the hero height on a phone (fixed ticker and receipt panel)', async ({ page }) => {
    await page.goto('/');
    const job = page.locator('[data-job]');
    const heroH = () => page.evaluate(() => Math.round(document.querySelector('.hero')!.getBoundingClientRect().height));
    const h0 = await heroH();
    await job.locator('[data-qe="CONDITIONAL"]').click({ timeout: 30_000 });
    await expect(job.locator('.ask-again')).toBeVisible();
    expect(await heroH(), 'the refused-delivery receipt grew the hero').toBe(h0);
    await job.locator('.ask-again [data-qe="PASS"]').click();
    await expect(job.locator('[data-panel]')).toContainText('DELIVERED', { timeout: 10_000 });
    expect(await heroH()).toBe(h0);
  });

  test('workflow names never wrap, and What’s new is a carousel', async ({ page }) => {
    await page.goto('/');
    // one line box per name (a Range sees text lines; an element's own rects do not), and it fits its tab
    const tabs = await page.locator('.wf-tab').evaluateAll((els) => els.map((tab) => {
      const code = tab.querySelector('code')!;
      const r = document.createRange();
      r.selectNodeContents(code);
      const tops = new Set(Array.from(r.getClientRects()).map((q) => Math.round(q.top)));
      return { name: code.textContent, lines: tops.size, fits: code.scrollWidth <= (tab as HTMLElement).clientWidth };
    }));
    const bad = tabs.filter((t) => t.lines !== 1 || !t.fits);
    expect(bad, `workflow names that wrap or overflow: ${JSON.stringify(bad)}`).toEqual([]);
    const news = page.locator('#news');
    await bringIntoView(news);
    await expect(news.locator('[data-car-count]')).toHaveText('1 of 6');
    await news.locator('[data-car-next]').click();
    await expect(news.locator('[data-car-count]')).toHaveText('2 of 6');
    // the carousel really moved: the second note is the one in view
    await expect.poll(() => news.locator('.news-list').evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    await expect(news.locator('.news-list li').nth(1)).toBeInViewport({ ratio: 0.9 });
  });

  test('the proofs and the four-plane map render on a phone', async ({ page }) => {
    await page.goto('/');
    for (const sel of ['.sbx-map', '.disp-steps', '.rcx-card', '.wf-stage', '.install--primary']) {
      const loc = page.locator(sel);
      await bringIntoView(loc);
      await expect(loc).toBeVisible();
    }
    const map = page.locator('.same-garden');
    await bringIntoView(map);
    await expect(map.locator('.sg-plane')).toHaveCount(4);
  });

  test('every link and button is a 44px touch target, the shared chrome and the demo\'s decisions included', async ({ page }) => {
    // reduced motion: Run goes straight to the QE question and each answer lands at once
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const audit = (state: string) => page.evaluate((st) => {
      const sel = 'a[href], button, [tabindex]:not([tabindex="-1"]), input, select, summary';
      return Array.from(document.querySelectorAll<HTMLElement>(sel)).flatMap((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden], [aria-hidden="true"]')) return [];
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return [];
        if (r.width >= 44 && r.height >= 44) return [];
        const name = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        return [`${st}: ${el.tagName.toLowerCase()}.${el.className} "${name}" ${Math.round(r.width)}x${Math.round(r.height)}`];
      });
    }, state);
    // 600px: the phone sizing runs to 760px (codex review: a misplaced media block had cut it at 560)
    for (const size of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 600, height: 900 }]) {
      await page.setViewportSize(size);
      await page.goto('/');
      const job = page.locator('[data-job]');
      const small = await audit('page');
      // the QE question, then the refused delivery with its ask-again choices
      await job.locator('[data-job-run]').click();
      await expect(job.locator('[data-qe="PASS"]')).toBeVisible();
      small.push(...await audit('QE question'));
      await job.locator('[data-qe="CONDITIONAL"]').click();
      await expect(job.locator('.ask-again [data-qe="PASS"]')).toBeVisible();
      small.push(...await audit('refused delivery'));
      // the larger choices still fit the fixed receipt box: it never has to scroll
      const [sh, ch] = await job.locator('[data-panel]').evaluate((el) => [el.scrollHeight, el.clientHeight]);
      expect(sh, `the refused-delivery receipt overflows its box at ${size.width}x${size.height}`).toBeLessThanOrEqual(ch + 1);
      expect(small, `targets under 44px at ${size.width}x${size.height}`).toEqual([]);
    }
  });

  test('a phone frame (taller than the window) rises in as soon as a tenth of the window shows it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const get = page.locator('#get');
    // creep up to it, 4px at a time, and stop at 92px on screen: past a tenth of the 844px window,
    // under 10% of the ~980px frame (a stepped-threshold observer would still be waiting here)
    const at = (px: number) => get.evaluate((el, v) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - window.innerHeight + v, behavior: 'instant' }), px);
    for (let px = 40; px <= 92; px += 4) {
      await at(px);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    await expect(get).toHaveClass(/is-arrived/);
    // and 30% of a frame is no longer needed: far short of it, its heading is not left blank
    expect(await get.evaluate((el) => (window.innerHeight - el.getBoundingClientRect().top) / el.getBoundingClientRect().height)).toBeLessThan(0.3);
  });

  test('each install Copy label sits in the middle of its 44px button', async ({ page }) => {
    await page.goto('/');
    const off = await page.locator('.install__copy').evaluateAll((bs) => bs.map((b) => {
      const r = b.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(b);
      const t = Array.from(range.getClientRects()).find((x) => x.height > 0)!;
      return { h: Math.round(r.height), dy: Math.abs((t.top + t.bottom) / 2 - (r.top + r.bottom) / 2), dx: Math.abs((t.left + t.right) / 2 - (r.left + r.right) / 2) };
    }));
    expect(off.length).toBe(1); // one install path: the family installer
    for (const o of off) {
      expect(o.h).toBeGreaterThanOrEqual(44);
      expect(o.dy, `the label is ${o.dy.toFixed(1)}px off the middle`).toBeLessThanOrEqual(1);
      expect(o.dx).toBeLessThanOrEqual(1);
    }
  });

  test('the header keeps the mark and "labs / wicked-crew"; the menu leads with Wicked Labs', async ({ page }) => {
    await page.goto('/');
    const path = page.locator('.topbar').getByRole('navigation', { name: 'Breadcrumb' });
    // the lockup shows only its mark on a phone (its lettering clipped), in a 44px target; the two
    // text crumbs stay whole, 44px tall
    expect(await path.locator('.wordmark-lockup').evaluate((svg) => getComputedStyle(svg).clipPath)).toContain('22px');
    const mark = (await path.locator('.wordmark').boundingBox())!;
    expect(Math.min(mark.width, mark.height), 'the mark is a 44px target').toBeGreaterThanOrEqual(44);
    // its focus ring is drawn inside its box, so the window's left edge never cuts it (codex review)
    for (let k = 0; k < 4 && !(await path.locator('.wordmark').evaluate((el) => el === document.activeElement)); k++) await page.keyboard.press('Tab');
    const ring = await path.locator('.wordmark').evaluate((el) => {
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      return { focused: el.matches(':focus-visible'), left: r.left - parseFloat(cs.outlineOffset) - parseFloat(cs.outlineWidth) };
    });
    expect(ring.focused).toBe(true);
    expect(ring.left, 'the focus ring starts off the window').toBeGreaterThanOrEqual(0);
    for (const [name, href] of [['labs', 'https://wickedlabs.ai/'], ['wicked-crew', 'https://wc.wickedagile.com']]) {
      const l = path.getByRole('link', { name, exact: true });
      await expect(l).toHaveAttribute('href', href);
      expect(await l.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${name} is cut`).toBe(true);
      expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.locator('#menuBtn').click();
    const menu = page.locator('#mobileMenu');
    await expect(menu).toBeVisible();
    const first = menu.getByRole('link').first();
    await expect(first).toContainText('Wicked Labs');
    await expect(first).toHaveAttribute('href', 'https://wickedlabs.ai/');
  });

  // codex (local review, studio): the path cut the package name short at 641-720, with this site's
  // 44px icons beside the full lockup
  for (const width of [360, 390, 641, 700, 721, 768]) {
    test(`the header's path shows the whole package name @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      await page.evaluate(async () => { await document.fonts.ready; });
      const name = page.locator('.topbar .crumbs').getByRole('link', { name: 'wicked-crew', exact: true });
      await expect(name).toBeInViewport({ ratio: 1 });
      expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    });
  }
});
