import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * The two install copy buttons — click → "Copied" feedback + the command lands
 * on the clipboard (permissions granted; 127.0.0.1 is a secure context).
 */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.describe('install copy buttons', () => {
  test('family installer copy button copies the install and serve commands and shows feedback', async ({ page }) => {
    await page.goto('/');
    const btn = page.getByRole('button', { name: 'Copy family installer and serve commands' });
    await bringIntoView(btn);
    await btn.click();

    await expect(btn).toHaveText('Copied');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('npx wicked-installer\nwicked-crew serve');

    // Feedback resets after ~1.4s.
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

test.describe('deep links', () => {
  test('the live anchors still resolve (DECISIONS cites #council-h)', async ({ page }) => {
    await page.goto('/');
    for (const id of ['sandbox-h', 'council-h', 'gates-h', 'durable-h', 'get']) {
      await expect(page.locator(`#${id}`), `#${id}`).toHaveCount(1);
    }
    for (const [sec, h] of [['build', 'sandbox-h'], ['review', 'council-h'], ['gate', 'gates-h'], ['deliver', 'durable-h']]) {
      await expect(page.locator(`#${sec}`)).toHaveAttribute('aria-labelledby', h);
    }
  });
});

test.describe('the reviewed messaging', () => {
  test('the kicker, the sub-line, the benefits and what is new read as whole sentences', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.hero-kicker')).toHaveText('Intent in. Gated work out.');
    // the caveat label is quoted in plain text (the words PR's rendering), not a coloured chip
    await expect(page.locator('.lede')).toContainText('is labelled “approved by default, not verified”.');
    expect(await page.locator('.lede .glabel').count()).toBe(0);
    // the three benefits now lead the beats they describe (Build, Review, Gate); textContent, because
    // the explorables keep every state in the DOM and show one at a time
    const text = async (sel: string) => ((await page.locator(sel).textContent()) || '').replace(/\s+/g, ' ');
    expect(await text('#build')).toContain('Your agents, sandboxed. By default each runs in a sandbox');
    expect(await text('#build')).toContain('Keys stay in a broker and the sandbox sees placeholders. A Claude subscription’s sign-in token is the one exception');
    expect(await text('#build')).toContain('Your accounts, your plans: no billing, no reselling.');
    expect(await text('#review')).toContain('A failed check sends work back, waits for you or stops the job.');
    expect(await text('#review')).toContain('up to three hand-off attempts in all');
    expect(await text('#gate')).toContain('a feature, bug fix, migration, MCP server or editor plugin pass QE acceptance first');
    expect(await text('#gate')).toContain('By default, a different agent reviews the work.');
    for (const label of ['approved by default, not verified', 'floor only', 'reduced assurance', 'QE acceptance skipped by operator']) {
      await expect(page.locator('#gate .rcx-pick')).toContainText(label);
    }
    // each row is exactly "<name> <line>": the space between them is the guard
    const news = (await page.locator('.news-list li').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
    expect(news.length).toBe(6);
    expect(news[0]).toMatch(/^01 Documents in Hand a job your PDFs, text or images\./);
    expect(news[1]).toMatch(/^02 Reports with sources Research, Competitive, Due diligence/);
    expect(news[2]).toMatch(/^03 Review a change \/review-change with a pull request/);
    expect(news[3]).toMatch(/^04 Publish an app Publish builds an app’s container image on your machine/);
    expect(news[4]).toBe('05 Phase plugins /plugin phase builds a plugin that adds a section to every job’s details, drawn from its events. Installing it asks you to approve each event topic it reads.');
    // the scope qualifiers stay attached to their claims
    expect(news[0]).toContain('A PDF with no readable text is set aside, with the reason');
    expect(news[1]).toContain('A job names the data sources it may query, the public web included, and queries only those.');
    expect(news[2]).toContain('judged by agents that wrote none of it');
    expect(news[2]).toContain('Nothing is posted to the pull request.');
    expect(news[3]).toContain('Signed-in viewers by default; a public app (every query public, no actions) gets an embed snippet.');
    expect(news[5]).toMatch(/^06 Run cost Ask what 40 bug fixes a month would cost\./);
    // crew 0.18.0's scope: plugins observe a job's events (no intercept hooks); publishing builds an image and
    // deploys nothing; no Teams. None of these is ever named as shipped.
    expect(news.join(' ')).not.toMatch(/intercept|Teams|deploys? (it|your app)|coming soon|adds? an? (step|check|review|gate|approval)/i);
    // the counter names every card
    expect(await page.locator('[data-car-count]').textContent()).toBe('1 of 6');
    // the data gate's fact card, in the Deliver beat
    expect(await text('#deliver')).toContain('Your data, through one gate. Agents read a database only where you allow it');
    // the garden floor is crew 0.18.0's REQUIRED_GARDEN_VERSION
    expect(await text('#get')).toContain('wicked-garden 12.67.0 or later');
    // the install flow: the family installer, then wicked-crew serve, then the local URL
    expect(await text('#get')).toContain('npx wicked-installer # picks crew, garden and the rest wicked-crew serve # then open http://127.0.0.1:7701');
    expect(await text('#get')).toContain('then serves studio at http://127.0.0.1:7701');
    // one install path: no crew-only npm install that would skip garden
    expect(await text('#get')).not.toContain('npm install -g wicked-crew');
    expect(await page.content()).not.toContain('npx wicked-crew serve');
    // What's new comes after the proofs
    const order = await page.evaluate(() => Array.from(document.querySelectorAll('section[id]')).map((s) => s.id));
    expect(order.indexOf('news')).toBeGreaterThan(order.indexOf('deliver'));
    // crew's own sections; the shared family map (.same-garden) renders the pinned wicked-web's copy
    const own = await page.evaluate(() =>
      Array.from(document.querySelectorAll('main section, body > section, .finale > section'))
        .filter((s) => !s.closest('.same-garden'))
        .map((s) => (s as HTMLElement).textContent || '')
        .join(' ')
        .replace(/\s+/g, ' '),
    );
    expect(own.length).toBeGreaterThan(1000);
    expect(own).not.toMatch(/never claimed|never asserted/i);
    expect(own).not.toMatch(/one failed check stops/i);
    // one sandbox heading, not two
    expect(own).not.toContain('Your agents, in sandboxes.');
    // crew ships the sandbox images, never the agent CLIs (they come from their publishers)
    expect((own.match(/ships with crew/g) || []).length).toBe((own.match(/sandbox image ships with crew; you sign in with your own account/g) || []).length);
    // QE is required by the job's kind (a built-in), not because "the job changes the app"
    expect(own).not.toMatch(/changes the app/);
    expect(own).toContain('QE acceptance required: a feature job passes it before delivery');
    // the demo is a phased job; the send-back rule names its mode
    expect(own).toContain('job r-4f2a · feature · phased');
    expect(await text('#review')).toContain('In a phased job, after two send-backs, the job asks you instead.');
    // the broker's exception is on the map itself, and is the caption shown before any click
    expect(await text('#build')).toContain('keys → placeholders, one exception');
    await expect(page.locator('#sbx-cap [data-cap="broker"]')).toHaveClass(/is-on/);
    // public words: no "seat"
    expect(own).not.toMatch(/\bseats?\b/i);
  });
});
