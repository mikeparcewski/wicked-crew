import { test, expect, type Page } from '@playwright/test';

/**
 * Frames lock in without ever fighting the wheel.
 *
 * History: `mandatory` snap made the page unscrollable at 1440x760 (crew#337, wicked-studio#132);
 * `proximity` fixed that, but Chromium's proximity captures anything within a third of a frame, so
 * slow 100px wheel notches from a frame top were pulled straight back to it: ten notches left scrollY
 * at 0 at 1440x700 and at 1920x1080. The page now has ONE mechanism instead (src/scripts/settle.js):
 * CSS snap is off, and every user scroll comes to rest on a frame top: the next one after where the
 * gesture started, in the direction of travel (a nudge returns; a small overshoot snaps back; a key
 * steps one frame; the bottom of the page counts as a frame). A first version only settled when the
 * next top was within 45% of a frame, so most wheel rests stopped mid-frame, half of two sections
 * showing, and paging up never realigned.
 *
 * These tests drive the page with REAL wheel events (page.mouse.wheel). window.scrollBy() emits no
 * wheel event and bypasses the scroll machinery entirely.
 */

/** Every block that must be reachable, in document order (id, or the first class name). */
const SECTIONS = ['job', 'build', 'review', 'gate', 'deliver', 'news', 'same-garden', 'get', 'footer'];

const nameOf = `(el) => el.id || String(el.className).split(' ')[0]`;

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
async function frameTops(page: Page) {
  return page.evaluate(() => {
    const tb = document.querySelector('.topbar')!.getBoundingClientRect().height;
    return Array.from(document.querySelectorAll('[data-frame], .same-garden, .footer')).map((el) =>
      Math.round(el.getBoundingClientRect().top + window.scrollY - tb));
  });
}
/** Every resting place the settle may use: the frame tops, clamped to the page, and the page bottom. */
async function restTops(page: Page) {
  const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  const t = (await frameTops(page)).map((v) => Math.min(max, Math.max(0, v)));
  t.push(max);
  return [...new Set(t)].sort((a, b) => a - b);
}
const onAFrame = (y: number, tops: number[]) => tops.some((t) => Math.abs(t - y) <= 2);
/** Wait until the settle's glide is visibly under way: strictly between `from` and `to`. */
async function midGlide(page: Page, from: number, to: number) {
  for (let k = 0; k < 120; k++) {
    const y = await page.evaluate(() => window.scrollY);
    if (y > from + 8 && y < to - 8) return y;
    await page.waitForTimeout(10);
  }
  throw new Error(`no glide from ${from} to ${to} was seen`);
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

  for (const vp of [{ w: 1440, h: 700 }, { w: 1920, h: 1080 }]) {
    test(`every wheel rest locks onto a frame, in the direction of travel @ ${vp.w}x${vp.h}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto('/');
      await page.waitForTimeout(400);
      await page.mouse.move(vp.w / 2, 120);
      const tops = await frameTops(page);
      // one notch: the next frame (a 100px notch is a deliberate move, even on a 1016px frame)
      await page.mouse.wheel(0, 100);
      expect(Math.abs((await settled(page)) - tops[1])).toBeLessThanOrEqual(2);
      // one more: the frame after (the old settle left this rest 100px into Build)
      await page.mouse.wheel(0, 100);
      expect(Math.abs((await settled(page)) - tops[2])).toBeLessThanOrEqual(2);
      // a three-notch flick: one frame
      for (let k = 0; k < 3; k++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(50); }
      expect(Math.abs((await settled(page)) - tops[3])).toBeLessThanOrEqual(2);
      // a notch up: back one frame, never left mid-frame
      await page.mouse.wheel(0, -100);
      expect(Math.abs((await settled(page)) - tops[2])).toBeLessThanOrEqual(2);
      // a 30px nudge: back to the frame it started on; a second one the same way adds up: on
      await page.mouse.wheel(0, 30);
      expect(Math.abs((await settled(page)) - tops[2])).toBeLessThanOrEqual(2);
      await page.mouse.wheel(0, 30);
      expect(Math.abs((await settled(page)) - tops[3]), 'gentle nudges kept the visitor on the frame').toBeLessThanOrEqual(2);
      // one long move a little past a frame top: that frame, so an overshoot never builds up
      await page.mouse.wheel(0, tops[4] - tops[3] + 30);
      expect(Math.abs((await settled(page)) - tops[4])).toBeLessThanOrEqual(2);
    });
  }

  test('a notch the other way during a glide wins @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);
    await page.mouse.move(720, 120);
    const tops = await frameTops(page);
    await page.mouse.wheel(0, 100);
    await midGlide(page, 100, tops[1]);   // the glide to Build is under way
    await page.mouse.wheel(0, -100);
    expect(await settled(page), 'the glide carried on past the visitor reversing it').toBeLessThanOrEqual(2);
  });

  test('a PageDown and a PageUp before the settle cancel out @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);
    const tops = await frameTops(page);
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), tops[2]);
    await page.waitForTimeout(500);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(140);
    await page.keyboard.press('PageUp');
    expect(Math.abs((await settled(page)) - tops[2]), 'opposite keys were counted the same way').toBeLessThanOrEqual(2);
  });

  test('slow, gentle nudges still move on @ 1440x700', async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);
    await page.mouse.move(720, 120);
    const tops = await frameTops(page);
    await page.mouse.wheel(0, 30);
    expect(await settled(page)).toBeLessThanOrEqual(2);
    await page.waitForTimeout(3000);   // a pause longer than any idle window
    await page.mouse.wheel(0, 30);
    expect(Math.abs((await settled(page)) - tops[1]), 'two slow nudges the same way left the visitor on the hero').toBeLessThanOrEqual(2);
  });

  test('reduced motion switched on during a glide stops it @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);
    await page.mouse.move(720, 120);
    const tops = await frameTops(page);
    await page.mouse.wheel(0, 100);
    const at = await midGlide(page, 100, tops[1]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const y = await settled(page);
    expect(y, `the glide went on to ${y} after reduced motion was switched on at ${Math.round(at)}`).toBeLessThan(tops[1] - 8);
  });

  test('a burst of arrow keys never ends behind where it scrolled to @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);
    const tops = await restTops(page);
    for (let k = 0; k < 30; k++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(40); }
    const reached = await page.evaluate(() => Math.round(window.scrollY));
    const y = await settled(page);
    expect(onAFrame(y, tops), `rested at ${y}, off every frame top`).toBe(true);
    expect(y, `pulled back from ${reached} to ${y}`).toBeGreaterThanOrEqual(reached - 2);
  });

  test('a Tab during a glide stops it, so the focused control stays in view @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);
    await page.locator('[data-job-run]').focus();
    await page.waitForTimeout(900);   // past the settle's guard after a keyboard focus
    await page.mouse.move(720, 120);
    const tops = await frameTops(page);
    await page.mouse.wheel(0, 100);
    await midGlide(page, 100, tops[1]);   // the glide to Build is under way
    await page.keyboard.press('Tab');
    await settled(page);
    await page.waitForTimeout(400);
    const vis = await page.evaluate(() => {
      const r = document.activeElement!.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), bar: Math.round(document.querySelector('.topbar')!.getBoundingClientRect().bottom), vh: innerHeight };
    });
    expect(vis.top, `focused control at ${vis.top}px, under the topbar or off screen`).toBeGreaterThanOrEqual(vis.bar);
    expect(vis.bottom).toBeLessThanOrEqual(vis.vh);
  });

  test('keys step one frame per press, and paging up from the bottom lands on Get it @ 1440x700', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('/');
    await page.waitForTimeout(400);
    const tops = await restTops(page);
    for (let k = 1; k <= 4; k++) {
      await page.keyboard.press('PageDown');
      const y = await settled(page);
      expect(Math.abs(y - tops[k]), `PageDown ${k} rested at ${y}, frame top ${tops[k]}`).toBeLessThanOrEqual(2);
    }
    // from the very bottom, PageUp and Shift+Space each land on a frame top: first Get it's
    const max = tops[tops.length - 1];
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), max);
    await page.waitForTimeout(500);
    const getTop = await page.evaluate(() => Math.round(document.getElementById('get')!.getBoundingClientRect().top + window.scrollY - document.querySelector('.topbar')!.getBoundingClientRect().height));
    await page.keyboard.press('PageUp');
    expect(Math.abs((await settled(page)) - getTop), 'PageUp from the end did not land on Get it').toBeLessThanOrEqual(2);
    for (let k = 0; k < 3; k++) {
      await page.keyboard.press('Shift+Space');
      const y = await settled(page);
      expect(onAFrame(y, tops), `Shift+Space rested at ${y}, off every frame top`).toBe(true);
    }
  });

  for (const vp of [{ w: 1440, h: 700 }, { w: 1440, h: 760 }]) {
    test(`the mouse wheel reaches every section @ ${vp.w}x${vp.h}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto('/');
      await page.waitForTimeout(600);
      await page.mouse.move(vp.w / 2, vp.h / 2);

      // the hero is where the page starts (every rest is a frame, so the first notch already leaves it)
      const seen = new Set<string>(['job']);
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

  for (const vp of [{ w: 1440, h: 700 }, { w: 1920, h: 1080 }]) {
    test(`the shared platform band is one frame tall, so Get it lands on its top @ ${vp.w}x${vp.h}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto('/');
      await page.waitForTimeout(600);
      const { h, usable } = await page.evaluate(() => ({
        h: Math.round(document.querySelector('.same-garden')!.getBoundingClientRect().height),
        usable: innerHeight - Math.round(document.querySelector('.topbar')!.getBoundingClientRect().height),
      }));
      expect(Math.abs(h - usable), `band ${h}px, frame ${usable}px`).toBeLessThanOrEqual(1);
    });
  }
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
});
