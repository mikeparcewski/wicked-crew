import type { Locator } from '@playwright/test';

/**
 * Instant JS scroll that skips Playwright's "stable bounding box" wait.
 *
 * The page runs several independent autoplay intervals (gate console 2.8s,
 * workflows 3s, rail 2s, council 3.2s, studio feed 0.7s) that keep shifting
 * layout, so `scrollIntoViewIfNeeded()` can starve on its stability check.
 * Scrolling is only needed to trigger the IntersectionObserver-armed widgets;
 * subsequent clicks/assertions perform their own actionability checks.
 */
export async function bringIntoView(loc: Locator): Promise<void> {
  await loc.evaluate((el) => el.scrollIntoView({ block: 'center' }));
}
