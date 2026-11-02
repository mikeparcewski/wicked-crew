import { test, expect, type Page } from '@playwright/test';

/**
 * Frames lock in without ever fighting the wheel.
 *
 * History: `mandatory` snap made the page unscrollable at 1440x760 (crew#337, wicked-studio#132);
 * `proximity` fixed that, but Chromium's proximity captures anything within a third of a frame, so
 * slow 100px wheel notches from a frame top were pulled straight back to it: ten notches left scrollY
 * at 0 at 1440x700 and at 1920x1080. The page now has ONE mechanism instead (src/scripts/settle.js):
 * CSS snap is off, and when a user scroll comes to rest the page glides to the next frame top in the
 * direction of travel, only when that top is within 45% of a frame.
 *
 * These tests drive the page with REAL wheel events (page.mouse.wheel). window.scrollBy() emits no
 * wheel event and bypasses the scroll machinery entirely.
 */

/** Every block that must be reachable, in document order (id, or the first class name). */
const SECTIONS = ['job', 'build', 'review', 'gate', 'deliver', 'news', 'same-garden', 'get', 'footer'];

const nameOf = `(el) => el.id || String(el.className).split(' ')[0]`;

async function settled(page: Page) {
  // wait for the wheel's own scroll and any settle glide to finish
  let last = -1;
  for (let k = 0; k < 30; k++) {
    await page.waitForTimeout(120);
    const y = await page.evaluate(() => Math.round(window.scrollY));
    if (y === last) return y;
    last = y;
  }
  return last;
}
async function frameTops(page: Page) {
  return page.evaluate(() => {
    const tb = document.querySelector('.topbar')!.getBoundingClientRect().height;
    return Array.from(document.querySelectorAll('[data-frame], .same-garden, .footer')).map((el) =>
      Math.round(el.getBoundingClientRect().top + window.scrollY - tb));
  });
}

test.describe('frames and the settle', () => {
  test('CSS snap is off: one mechanism, and every frame is a frame @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollSnapType)).toBe('none');
    const names = await page.evaluate(`Array.from(document.querySelectorAll('[data-frame]')).map(${nameOf})`);
    expect(names).toEqual(['job', 'build', 'review', 'gate', 'deliver', 'news', 'get']);
  });

  for (const vp of [{ w: 1440, h: 700 }, { w: 1920, h: 1080 }]) {
    test(`ten slow 100px wheel notches get past the hero @ ${vp.w}x${vp.h}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto('/');
      await page.waitForTimeout(400);
      await page.mouse.move(vp.w / 2, vp.h / 2);
      for (let k = 0; k < 10; k++) {
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(300);
      }
      const y = await settled(page);
      const tops = await frameTops(page);
      expect(y, `scrollY ${y}: the wheel was pulled back to the hero`).toBeGreaterThanOrEqual(tops[1] - 2);
    });
  }

  test('a settle goes the way you scroll, never back @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);
    await page.mouse.move(720, 350);
    const tops = await frameTops(page);
    // 400px down from the hero: the next frame's top is within 45% -> it glides there
    await page.mouse.wheel(0, 400);
    expect(Math.abs((await settled(page)) - tops[1])).toBeLessThanOrEqual(2);
    // one notch further: the frame after is far away, so the page stays where the wheel left it
    await page.mouse.wheel(0, 100);
    const y = await settled(page);
    expect(y, 'pulled back to the frame top it had just left').toBeGreaterThan(tops[1] + 50);
    expect(y).toBeLessThan(tops[2] - 50);
  });

  for (const vp of [{ w: 1440, h: 700 }, { w: 1440, h: 760 }]) {
    test(`the mouse wheel reaches every section @ ${vp.w}x${vp.h}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto('/');
      await page.waitForTimeout(600);
      await page.mouse.move(vp.w / 2, vp.h / 2);

      const seen = new Set<string>();
      let lastY = -1;
      let stuck = 0;
      for (let step = 0; step < 80; step++) {
        await page.mouse.wheel(0, 320);
        await settled(page);
        const cur = await page.evaluate((vh) => {
          const els = Array.from(document.querySelectorAll('section, .same-garden, .footer'));
          let best = '';
          let bestVis = -1;
          for (const el of els) {
            const r = el.getBoundingClientRect();
            const vis = Math.min(r.bottom, vh) - Math.max(r.top, 0);
            if (vis > bestVis) { bestVis = vis; best = el.id || String((el as HTMLElement).className).split(' ')[0]; }
          }
          return {
            y: Math.round(window.scrollY),
            best,
            atEnd: Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 2,
          };
        }, vp.h);
        seen.add(cur.best);
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

  test('a keyboard focus that scrolls the page is never moved by the settle @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);
    // Tab to the first sandbox hotspot: the browser scrolls it into view; the settle must not move it away
    await page.locator('[data-hot="repo"]').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await settled(page);
    await expect(page.locator('[data-hot="repo"]')).toBeFocused();
    await expect(page.locator('[data-hot="repo"]')).toBeInViewport();
  });

  test('no frame overflows the viewport @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(600);
    const tall = await page.evaluate(() =>
      Array.from(document.querySelectorAll('section, .same-garden'))
        .map((el) => ({ name: el.id || String((el as HTMLElement).className).split(' ')[0], h: Math.round(el.getBoundingClientRect().height) }))
        .filter((s) => s.h > window.innerHeight),
    );
    expect(tall, `sections taller than the 700px viewport: ${tall.map((s) => `${s.name}=${s.h}`).join(', ')}`).toEqual([]);
  });

  test('the shared platform band fits a laptop viewport @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(600);
    const h = await page.evaluate(() => Math.round(document.querySelector('.same-garden')!.getBoundingClientRect().height));
    expect(h).toBeLessThanOrEqual(700);
  });
});

test.describe('no settle under reduced motion', () => {
  // The settle moves the viewport for you: the motion the preference asks the page to suppress.
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('the page stays where the wheel left it @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);
    await page.mouse.move(720, 350);
    await page.mouse.wheel(0, 400);
    const y = await settled(page);
    expect(Math.abs(y - 400)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollSnapType)).toBe('none');
  });
});

test.describe('content is not truncated or orphaned', () => {
  test('install command blocks do not clip their trailing comment @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);
    const clipped = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.install__code'))
        .map((el) => ({
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
    const rects = await page.evaluate(() =>
      Array.from(document.querySelector('.get-tos a')!.getClientRects()).map((r) => Math.round(r.width)),
    );
    expect(rects.length).toBe(1);
    expect(rects[0]).toBeGreaterThan(40);
  });
});
