// Slice B / FINDINGS B1: when the skills' Python env can't be built, the user reads a plain cause
// with the one fix — never "venv-failed:", "uv sync did not produce", or a path. uv-missing and
// uv-sync-failed read differently. The finding KIND stays `venv-failed` (machine code).
import { describe, expect, it } from 'vitest';

import { scrubHomePaths } from '../src/api/ui-text.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold } from './support/skills-fixture.js';

describe('venv-failed finding wording (FINDINGS B1)', () => {
  it('uv missing → "Install uv", no "venv-failed:", no "uv sync did not produce", no path', async () => {
    const v = scaffold({ provisionVenv: async () => ({ state: 'failed', reason: 'uv-missing' }) });
    try {
      v.store.seed();
      const r = await v.store.publish(1);
      expect(r.verdict).toBe('blocked');
      const f = r.findings.find((x) => x.kind === 'venv-failed')!;
      expect(f.evidence).toContain('Install uv:');
      expect(f.evidence).toContain('https://docs.astral.sh/uv/getting-started/installation/');
      expect(f.evidence).toContain('press Publish');
      // What a user must NEVER read:
      expect(f.evidence).not.toContain('venv-failed:');
      expect(f.evidence).not.toContain('uv sync did not produce');
      expect(f.evidence).not.toMatch(/\.venv/);
      expect(f.evidence).not.toMatch(/\/Users\/|\/home\//);
      // The explanation (shown on the Skills page) is the same plain message.
      expect(f.explanation).toContain('Install uv');
    } finally {
      removeScratch(v.base);
    }
  });

  it('uv installed but sync failed → its own plain cause, no "Install uv", no path', async () => {
    const v = scaffold({ provisionVenv: async () => ({ state: 'failed', reason: 'sync-failed' }) });
    try {
      v.store.seed();
      const r = await v.store.publish(1);
      expect(r.verdict).toBe('blocked');
      const f = r.findings.find((x) => x.kind === 'venv-failed')!;
      expect(f.evidence).toContain('uv sync failed');
      expect(f.evidence).toContain('Publish again');
      expect(f.evidence).not.toContain('Install uv');
      expect(f.evidence).not.toContain('uv sync did not produce');
      expect(f.evidence).not.toMatch(/\/Users\/|\/home\//);
    } finally {
      removeScratch(v.base);
    }
  });

  it('a bare failed (no reason) defaults to the install-uv wording, so a user still gets a fix', async () => {
    const v = scaffold({ provisionVenv: async () => 'failed' });
    try {
      v.store.seed();
      const r = await v.store.publish(1);
      const f = r.findings.find((x) => x.kind === 'venv-failed')!;
      expect(f.evidence).toContain('Install uv');
    } finally {
      removeScratch(v.base);
    }
  });
});

describe('scrubHomePaths used by the blocked-skills line', () => {
  it('a home path in a finding evidence is folded before it reaches the Nerve Center message', () => {
    // runtime.ts builds `Skills can't be published: <scrubbed evidence>`; prove the scrub it uses.
    expect(scrubHomePaths('no /Users/alice/.wicked-crew/skills in effective/')).toMatch(/^no ~\/.wicked-crew\/skills in effective\/$/);
  });
});
