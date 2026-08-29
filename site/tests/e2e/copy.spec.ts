import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * The two install copy buttons — click → "Copied" feedback + the command lands
 * on the clipboard (permissions granted; 127.0.0.1 is a secure context).
 */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.describe('install copy buttons', () => {
  test('family installer copy button copies the command and shows feedback', async ({ page }) => {
    await page.goto('/');
    const btn = page.getByRole('button', { name: 'Copy family installer command' });
    await bringIntoView(btn);
    await btn.click();

    await expect(btn).toHaveText('Copied');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('npx wicked-installer');

    // Feedback resets after ~1.4s.
    await expect(btn).toHaveText('Copy');
  });

  test('direct install copy button copies both commands', async ({ page }) => {
    await page.goto('/');
    const btn = page.getByRole('button', { name: 'Copy direct install commands' });
    await bringIntoView(btn);
    await btn.click();

    await expect(btn).toHaveText('Copied');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('npm install -g wicked-crew\nwicked-crew serve');

    await expect(btn).toHaveText('Copy');
  });
});

/**
 * Rendered-text fusion guard. Astro's default `compressHTML` deletes the
 * newline between a text node and a following inline tag (<b>/<code>/<a>),
 * fusing rendered words: this page shipped "thedocument engine",
 * "asacyclic-validated" and "/api/v1.wicked-studio" that way. The config now
 * sets `compressHTML: false`; this test fails loudly if that regresses.
 * Phrases are checked in rendered innerText — a measurement can't see this,
 * only the text can.
 */
test.describe('inline-tag boundaries render with their spaces', () => {
  test('known fusion-prone phrases are intact', async ({ page }) => {
    await page.goto('/');
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    for (const phrase of [
      'the document engine',       // .skins sec-sub: "the" + <b>document engine</b>
      'as acyclic-validated JSON', // .wf sec-sub: "as" + <b>acyclic-validated JSON</b>
      'visible during the run',    // .op-card: <i>during</i> + " the run"
    ]) {
      expect(text, `fused inline-tag boundary — expected "${phrase}"`).toContain(phrase);
    }
  });
});
