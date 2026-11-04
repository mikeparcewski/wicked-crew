import { test, expect } from '@playwright/test';
import { SIZES, place, scrollFor, watch, read, waitForMotion, expectStill, setHidden } from './offscreen-kit';

/**
 * Every interactive on the page stops when nobody can see it, and never moves the page
 * (operator, 2026-11-04: "when interactives are playing the scroll is scrolling back to them").
 *
 * For each one, at 1440x900, 1280x720 and 390x844: it plays on screen; off screen, and peeking in
 * under a quarter at an edge, nothing in it changes or animates for two of its cycles, the page
 * holds still and nothing takes focus; back on screen it carries on. A stop by the visitor (Kill,
 * Crash, a step picked) stays stopped when it comes back, and a hidden tab holds it too. The one-shot
 * motion (the install command typing itself, What's new staggering in) lands at once when it leaves,
 * and reduced motion switched on while an autoplay is held off screen settles it on its end state.
 */

const ITEMS = [
  { name: 'the hero job', sel: '[data-job]', cycle: 750, wait: 4000 },
  { name: 'the sandbox', sel: '[data-sbx]', cycle: 2400, wait: 3000, css: true },
  { name: 'the dispute stepper', sel: '[data-disp]', cycle: 900, wait: 3000 },
  { name: 'the receipt explorer', sel: '[data-rcx]', cycle: 2200, wait: 4000 },
  { name: 'the workflow rail', sel: '[data-wf]', cycle: 1100, wait: 3000 },
];

for (const size of SIZES) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    for (const it of ITEMS) {
      test(`${it.name} holds off screen and carries on when it is back`, async ({ page }) => {
        test.setTimeout(60_000);
        await page.goto('/');
        await place(page, it.sel, 'on');
        const css = 'css' in it;
        const playing = await waitForMotion(page, it.sel, it.wait, css);
        expect(css ? playing.running : playing.mutations, `${it.name} plays on screen`).toBeGreaterThan(0);
        expect(playing.moved, `${it.name}: the page moved while it played`).toBeLessThanOrEqual(1);
        await expectStill(page, it.sel, it.cycle, 'off', it.name);
        await expectStill(page, it.sel, it.cycle, 'edge', it.name);
        await place(page, it.sel, 'on');
        const again = await waitForMotion(page, it.sel, 2 * it.cycle + 1500, css);
        expect(css ? again.running : again.mutations, `${it.name} carries on back on screen`).toBeGreaterThan(0);
        expect(again.moved, `${it.name}: the page moved while it played`).toBeLessThanOrEqual(1);
        expect(again.focusMoved, `${it.name}: focus moved while it played`).toBe(false);
      });
    }

    test('a stop by the visitor stays stopped when it comes back on screen', async ({ page }) => {
      test.setTimeout(60_000);
      await page.goto('/');
      // the workflow rail: Crash it, leave, come back: still crashed, nothing steps
      await place(page, '[data-wf]', 'on');
      await waitForMotion(page, '[data-wf]', 3000);
      await page.locator('[data-wf-crash]').click();
      await place(page, '[data-wf]', 'off');
      await place(page, '[data-wf]', 'on');
      await watch(page, '[data-wf]');
      await page.waitForTimeout(2600);
      let s = await read(page, '[data-wf]');
      expect(s.mutations, 'a crashed rail stays crashed back on screen').toBe(0);
      expect(s.focusMoved).toBe(false);
      // the dispute stepper: a step picked by the visitor stops its autoplay for good
      await place(page, '[data-disp]', 'on');
      await waitForMotion(page, '[data-disp]', 3000);
      await page.locator('[data-dstep="1"]').click();
      await place(page, '[data-disp]', 'off');
      await place(page, '[data-disp]', 'on');
      await watch(page, '[data-disp]');
      await page.waitForTimeout(2200);
      s = await read(page, '[data-disp]');
      expect(s.mutations, 'a stepper the visitor stopped does not start again').toBe(0);
      expect(s.focusMoved).toBe(false);
    });

    test('a hidden tab holds the playing rail; visible again, it carries on', async ({ page }) => {
      test.setTimeout(45_000);
      await page.goto('/');
      await place(page, '[data-wf]', 'on');
      await waitForMotion(page, '[data-wf]', 3000);
      await setHidden(page, true);
      await watch(page, '[data-wf]');
      await page.waitForTimeout(2600);
      const s = await read(page, '[data-wf]');
      expect(s.mutations, 'DOM changes in a hidden tab').toBe(0);
      expect(s.running, 'animations running in a hidden tab').toBe(0);
      await setHidden(page, false);
      const again = await waitForMotion(page, '[data-wf]', 3500);
      expect(again.mutations, 'the rail carries on once the tab is visible').toBeGreaterThan(0);
    });

    test('one-shot motion that leaves mid-way lands at once: the typed command, the What\u2019s new stagger', async ({ page }) => {
      test.setTimeout(45_000);
      await page.goto('/');
      // the install command types itself once its box is 60% on screen
      await scrollFor(page, '.install', 'on');
      await expect(page.locator('[data-type]')).toHaveClass(/is-typing/, { timeout: 4000 });
      await expectStill(page, '.install', 1100, 'off', 'the typed command');
      await expect(page.locator('[data-type]'), 'the command shows whole once it left').not.toHaveClass(/is-armed|is-typing/);
      // What's new staggers its tiles in once (0.5 s each, 90 ms apart): leave at once
      await scrollFor(page, '[data-news]', 'on');
      await expect(page.locator('.news')).toHaveClass(/is-in/, { timeout: 4000 });
      await expectStill(page, '[data-news]', 1000, 'off', "What's new");
    });

    test('reduced motion switched on while an autoplay is held off screen settles it on its end state', async ({ page }) => {
      test.setTimeout(45_000);
      await page.goto('/');
      await place(page, '[data-disp]', 'on');
      await waitForMotion(page, '[data-disp]', 3000);
      await place(page, '[data-job]', 'on');
      await waitForMotion(page, '[data-job]', 4000);
      await place(page, '[data-wf]', 'on');
      await waitForMotion(page, '[data-wf]', 3000);
      await place(page, '#get', 'on');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const n = await page.locator('[data-dstep]').count();
      await expect(page.locator('[data-dcount]'), 'the stepper shows its last step').toHaveText(`${n} / ${n}`);
      await expect(page.locator('[data-job] [data-qe="PASS"]').first(), 'the job runs on to its decision').toBeAttached();
      await expect(page.locator('[data-wf-status]'), 'the rail shows the finished job').toContainText('done');
    });
  });
}
