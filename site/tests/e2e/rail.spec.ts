import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

const PHASES = /^(clarify|design|build|adversarial-review|test|review)$/;

/**
 * Durable lifecycle rail [data-rail] — auto-advances every 2s, pauses on mouse
 * hover (by design), and "Kill & resume" crashes the engine then resumes to
 * the exact phase it was on.
 */
test.describe('durable rail [data-rail]', () => {
  test('crash it — the rail resumes to the exact phase', async ({ page }) => {
    await page.goto('/');
    const rail = page.locator('[data-rail]');
    await bringIntoView(rail);

    // Mouse hover pauses the auto-advance, freezing the current phase.
    await rail.hover();
    const dockPhase = rail.locator('[data-dock-phase]');
    await expect(dockPhase).toHaveText(PHASES);
    const phaseBefore = (await dockPhase.textContent())!.trim();

    await rail.locator('[data-crash]').click();

    // Engine down: crashed state + dock reflects it…
    await expect(rail).toHaveClass(/is-crashed/);
    await expect(dockPhase).toHaveText('— (engine down)');

    // …then it comes back, resumed at the same phase (checkpointed cursor).
    await expect(rail).not.toHaveClass(/is-crashed/);
    await expect(dockPhase).toHaveText(phaseBefore);
  });

  test('clicking a phase jumps the run to it', async ({ page }) => {
    await page.goto('/');
    const rail = page.locator('[data-rail]');
    await bringIntoView(rail);
    await rail.hover(); // pause the auto-advance

    const buildPhase = rail.locator('[data-phase][data-i="2"]');
    await buildPhase.click();
    await expect(buildPhase).toHaveClass(/is-now/);
    await expect(rail.locator('[data-dock-phase]')).toHaveText('build');
    await expect(rail.locator('[data-dock-evidence]')).toContainText('diff');
  });
});
