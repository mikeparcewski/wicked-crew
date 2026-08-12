import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * Studio console mock [data-studio] — the hero's signature widget.
 * Launch → the event feed streams (700ms/step) → the steering gate raises →
 * a human resolves it. The submit handler resets + re-streams a fresh run,
 * which makes the flow deterministic regardless of the scroll-in auto-play.
 */
test.describe('studio console [data-studio]', () => {
  test('launch streams the feed, raises the steering gate, approve advances to ship', async ({ page }) => {
    await page.goto('/');
    const studio = page.locator('[data-studio]');
    await bringIntoView(studio);

    // Relaunch deterministically (the widget also auto-runs on scroll-in;
    // submitting resets the feed and streams a fresh run).
    await studio.locator('[data-studio-go]').click();

    const feed = studio.locator('[data-studio-feed]');
    await expect(feed.locator('.sf-row').first()).toBeVisible();

    // The stream ends held at the gate: 7 feed rows, gate visible, verdict DENY.
    const gate = studio.locator('[data-studio-gate]');
    await expect(gate).toBeVisible({ timeout: 15_000 });
    await expect(feed.locator('.sf-row')).toHaveCount(7);
    await expect(feed.locator('.sf-row').last()).toContainText('steering decision required');
    const stamp = studio.locator('[data-sg-stamp]');
    await expect(stamp).toHaveText('DENY');

    // All three steering actions are offered and live.
    const approve = gate.locator('[data-sg-action="approve"]');
    await expect(approve).toBeEnabled();
    await expect(gate.locator('[data-sg-action="steer"]')).toBeEnabled();
    await expect(gate.locator('[data-sg-action="reject"]')).toBeEnabled();

    // Approve advances the flow: verdict flips, the override is logged,
    // the governed terminal moves to ship, and the buttons retire.
    await approve.click();
    await expect(stamp).toHaveText('ALLOW');
    await expect(gate).toHaveAttribute('data-verdict', 'allow');
    await expect(feed.locator('.sf-row').last()).toContainText('allowed');
    await expect(studio.locator('[data-studio-term]')).toContainText('ship --run r-4f2a');
    await expect(approve).toBeDisabled();
  });
});
