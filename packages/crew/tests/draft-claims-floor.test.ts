import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runDraftFloor } from '../src/interactive/draft-skill.js';
import { buildSourcePacket, packetDirOf } from '../src/interactive/source-packet.js';
import type { ArtifactProposal, SessionView } from '../src/core/types.js';

// Observe the real child process without replacing the launcher or its report.
vi.mock('node:child_process', { spy: true });

const garden = process.env['WICKED_GARDEN_ROOT'];
const REQUIRED = process.env['WICKED_CLAIMS_FLOOR'] === 'required';
it.skipIf(!REQUIRED && !garden)('the real Crew claims floor accepts a packet citation and refuses an uncited figure', async () => {
  if (!garden) throw new Error('WICKED_CLAIMS_FLOOR=required but WICKED_GARDEN_ROOT is missing (expected a wicked-garden checkout)');
  const attempt = mkdtempSync(join(tmpdir(), 'crew-claims-floor-'));
  const spawn = vi.spyOn(childProcess, 'spawn');
  try {
    const packet = await buildSourcePacket({
      runId: 'draft', chatId: 'chat', pid: 'chat:turn', cutoffTurnId: 'turn', records: [],
      resolution: { what: { title: 'Coverage', label: 'Document' }, brief: 'coverage report', sources: [{ token: 'run:evidence', status: 'ok' }] } as ArtifactProposal,
    }, {
      runs: async () => [{ session: { id: 'evidence' } } as SessionView],
      brief: async () => ({ runId: 'evidence', title: 'Coverage', status: 'completed', markdown: 'Coverage reached 80%.\n', sha256: 'unused' }),
      docsRoot: async () => null, attachment: () => null,
    });
    const records = join(attempt, 'records');
    mkdirSync(records);
    for (const file of packet.canonical.filter((f) => packetDirOf(f.name) === 'records')) writeFileSync(join(records, file.name), file.bytes);
    const source = packet.canonical.find((f) => f.name.startsWith('run-'))!;
    const html = join(attempt, 'report.html');
    for (const cited of [true, false]) {
      writeFileSync(html, `<html><body><p${cited ? ` data-source="${source.name}:1"` : ''}>Coverage reached 80%.</p></body></html>`);
      const result = await runDraftFloor(html, { pages: null, exact: false, source: 'unknown' }, [records], {}, { gardenRoot: () => garden });
      expect(result.verdict, result.summary).toBe(cited ? 'pass' : 'fail');
      if (cited) expect(result.breaches).toEqual([]);
      else expect(result.breaches).toContainEqual(expect.stringMatching(/^claims:/));
    }
    expect(spawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining([join(garden, 'scripts', 'wicked-garden.mjs'), 'run', 'scripts/draft/self_check.py', '--repo', records]), expect.any(Object));
  } finally {
    spawn.mockRestore();
    rmSync(attempt, { recursive: true, force: true });
  }
});
