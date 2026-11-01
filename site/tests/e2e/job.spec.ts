import { test, expect, type Page } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * The hero's job demo, driven the way a visitor drives it: a job through plan, build, review (with a
 * dispute a council settles), QE acceptance and delivery; gate receipts; a crash and a resume.
 */

async function atQe(page: Page) {
  await page.goto('/');
  const job = page.locator('[data-job]');
  await bringIntoView(job);
  await expect(job.locator('[data-qe="PASS"]')).toBeVisible({ timeout: 30_000 });
  return job;
}

test.describe('the job demo', () => {
  test('runs plan, build and review, with a council settling the dispute, then waits on QE', async ({ page }) => {
    const job = await atQe(page);
    const log = job.locator('[data-log]');
    await expect(log).toContainText('only the worktree writable');
    await expect(log).toContainText('a different agent than the builder');
    await expect(log).toContainText('Codex holds the finding → dispute');
    await expect(log).toContainText('council ruled: finding stands · 2 of 3');
    await expect(log).toContainText('QE acceptance required');
    // Plan, Build and Review gates are closed and openable; QE and Deliver are not yet.
    for (const k of [0, 1, 2]) await expect(job.locator(`[data-gate="${k}"]`)).toBeEnabled();
    for (const k of [3, 4]) await expect(job.locator(`[data-gate="${k}"]`)).toBeDisabled();
  });

  test('a review gate receipt names the evaluator and the council ruling', async ({ page }) => {
    const job = await atQe(page);
    await job.locator('[data-gate="2"]').click();
    const panel = job.locator('[data-panel]');
    await expect(panel).toContainText('Review gate');
    await expect(panel).toContainText('Codex (a different agent)');
    await expect(panel).toContainText('finding stands · 2 of 3 · seed 4127');
  });

  test('anything but an attributed PASS refuses delivery; PASS delivers', async ({ page }) => {
    const job = await atQe(page);
    const log = job.locator('[data-log]');
    await job.locator('[data-qe="CONDITIONAL"]').click();
    await expect(log).toContainText('409 qe_acceptance_required · CONDITIONAL is not a pass');
    await expect(job.locator('[data-st="3"]')).toHaveClass(/is-held/);
    await expect(job.locator('[data-panel]')).toContainText('HELD');
    await expect(log).not.toContainText('pull request');

    await job.locator('[data-qe="NONE"]').click();
    await expect(log).toContainText('no verdict is not a pass');

    await job.locator('[data-qe="PASS"]').last().click();
    await expect(log).toContainText('acceptance read: PASS, attributed to r-4f2a');
    await expect(log).toContainText('pull request #42 opened', { timeout: 10_000 });
    await expect(job.locator('[data-panel]')).toContainText('DELIVERED', { timeout: 10_000 });
    await expect(job.locator('[data-st="3"]')).toHaveClass(/is-done/);
    await expect(job.getByRole('button', { name: 'Run it again' })).toBeEnabled();
  });

  test('killing the daemon stops the job; restarting resumes it at the step it was on', async ({ page }) => {
    await page.goto('/');
    const job = page.locator('[data-job]');
    await bringIntoView(job);
    const log = job.locator('[data-log]');
    await expect(log).toContainText('container started', { timeout: 15_000 });
    await job.getByRole('button', { name: 'Kill the daemon' }).click();
    await expect(log).toContainText('daemon killed mid-job');
    const linesAtKill = await log.locator('.ln').count();
    await page.waitForTimeout(1_800);
    expect(await log.locator('.ln').count(), 'the job kept running after the kill').toBe(linesAtKill);

    await job.getByRole('button', { name: 'Start the daemon' }).click();
    await expect(log).toContainText('boot sweep found r-4f2a orphaned');
    await expect(log).toContainText('run.resumed {via: boot} · re-entering');
    // Finished gates stay finished: the plan gate is still closed after the resume.
    await expect(job.locator('[data-gate="0"]')).toBeEnabled();
    await expect(job.locator('[data-qe="PASS"]')).toBeVisible({ timeout: 30_000 });
  });
});
