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
      'as a preset (PUT /api/v1/presets/:name).',   // .durable sec-sub: "as a preset (" + <code>
      'the same /api/v1 and /ws your tools can',   // .durable fact: <code> + " and " + <code>
      'Terms of service: crew drives CLIs',          // .get-tos: <b> + text
    ]) {
      expect(text, `fused inline-tag boundary — expected "${phrase}"`).toContain(phrase);
    }
  });
});

test.describe('the reviewed messaging', () => {
  test('the kicker, the sub-line, the benefits and what is new read as whole sentences', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.hero-kicker')).toHaveText('Intent in. Gated work out.');
    await expect(page.locator('.lede')).toContainText('approved by default, not verified');
    const why = (await page.locator('.why').innerText()).replace(/\s+/g, ' ');
    expect(why).toContain('Your agents, sandboxed. By default each runs in a sandbox');
    expect(why).toContain('up to three hand-off attempts in all');
    expect(why).toContain('a feature, bug fix, migration, MCP server or editor plugin pass QE acceptance first');
    const news = await page.locator('.news-list li').allTextContents();
    expect(news.length).toBe(6);
    for (const n of news) expect(n).toMatch(/^\S.*\S \S/); // a space between the name and its line
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    expect(body).not.toMatch(/never claimed|never asserted/i);
    expect(body).not.toMatch(/one failed check stops/i);
    await expect(page.locator('.tbl--layers')).toContainText('By default, a different agent reviews the work.');
  });
});
