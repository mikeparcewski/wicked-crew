import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * Gate console [data-gc] — auto-animating series-circuit dual gate.
 * Clicking an explainer card settles the demo on that card's scene (stops the
 * auto-advance), and clicking a switch takes manual control ([data-gc] gains
 * .is-manual — the state flag proving the auto-cycle stopped).
 */
test.describe('gate console [data-gc]', () => {
  test('deny-dominates: one open switch flips the verdict; interaction stops the auto-demo', async ({ page }) => {
    await page.goto('/');
    const gc = page.locator('[data-gc]');
    await bringIntoView(gc);

    // Settle on card 1's scene: all switches closed → ALLOW, auto-advance stopped.
    await page.locator('[data-gc-card]').first().click();
    const stamp = gc.locator('[data-stamp]');
    const mode = gc.locator('[data-gc-mode]');
    await expect(stamp).toHaveText('ALLOW');
    await expect(mode).toContainText('replay demo');

    // Open one deterministic policy switch.
    const sw = gc.locator('[data-sw][data-policy="schema-drift"]');
    await sw.click();

    // Deny dominates: the single open switch is the whole verdict.
    await expect(stamp).toHaveText('DENY');
    await expect(sw.locator('[data-state]')).toHaveText('FAIL');
    await expect(sw).toHaveAttribute('aria-pressed', 'false');
    await expect(gc.locator('[data-vline]')).toContainText('1 check failed');

    // The auto-cycle stopped: manual-mode class + mode chip (state flags,
    // not a "nothing changes over time" wait).
    await expect(gc).toHaveClass(/is-manual/);
    await expect(mode).toContainText('driving');

    // Close it again → the verdict flips back.
    await sw.click();
    await expect(stamp).toHaveText('ALLOW');
    await expect(sw.locator('[data-state]')).toHaveText('PASS');
    await expect(gc).toHaveClass(/is-manual/);
  });

  test('the LLM judge seat can veto but never approve', async ({ page }) => {
    await page.goto('/');
    const gc = page.locator('[data-gc]');
    await bringIntoView(gc);

    // Settle on the all-closed scene first.
    await page.locator('[data-gc-card]').first().click();
    const stamp = gc.locator('[data-stamp]');
    await expect(stamp).toHaveText('ALLOW');

    const judge = gc.locator('[data-sw][data-policy="llm-judge"]');
    await expect(judge.locator('[data-state]')).toHaveText('ABSTAIN');

    // The judge opens the circuit → veto.
    await judge.click();
    await expect(stamp).toHaveText('DENY');
    await expect(judge.locator('[data-state]')).toHaveText('VETO');
    await expect(gc.locator('[data-vline]')).toContainText('LLM judge vetoed');

    // Closing it returns to ABSTAIN — its closed state approves nothing.
    await judge.click();
    await expect(stamp).toHaveText('ALLOW');
    await expect(judge.locator('[data-state]')).toHaveText('ABSTAIN');
  });
});
