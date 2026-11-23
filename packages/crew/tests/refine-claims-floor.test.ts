// crew#1727: a chat refine's landing check runs garden's REAL claims scan with the refine's records and the document's
// grounded repositories as its folders, so a records citation is checked by line. Runs where CI checks out
// wicked-garden (WICKED_GARDEN_ROOT; required on Linux CI, like draft-claims-floor.test.ts).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { guardRefine } from '../src/interactive/landing-guard.js';
import { buildSourcePacket } from '../src/interactive/source-packet.js';
import type { ArtifactProposal, SessionView } from '../src/core/types.js';

const garden = process.env['WICKED_GARDEN_ROOT'];
const REQUIRED = process.env['WICKED_CLAIMS_FLOOR'] === 'required';
const RUN = '5e5e5e5e-1111-4000-8000-00000000000b';
const gardenConfines = (root: string): boolean => {
  const scan = join(root, 'scripts', 'draft', 'claims_scan.py');
  return existsSync(scan) && readFileSync(scan, 'utf8').includes('escaped-source');
};

it.skipIf(!REQUIRED && !garden)('the refine floor refuses a wrong or made-up records citation and lands a correct one beside a repository citation', async () => {
  if (!garden) throw new Error('WICKED_CLAIMS_FLOOR=required but WICKED_GARDEN_ROOT is missing (expected a wicked-garden checkout)');
  const dir = mkdtempSync(join(tmpdir(), 'crew-refine-claims-'));
  try {
    // The packet exactly as the refine's proposal builds it (source-packet.ts buildSourcePacket): one run brief record.
    const packet = await buildSourcePacket({
      runId: RUN, chatId: 'chat', pid: 'chat:turn', cutoffTurnId: 'turn', records: [],
      resolution: { what: { title: 'Coverage', label: 'Change' }, brief: 'revise', sources: [{ token: 'run:evidence', status: 'ok' }] } as ArtifactProposal,
    }, {
      runs: async () => [{ session: { id: 'evidence' } } as SessionView],
      brief: async () => ({ runId: 'evidence', title: 'Coverage', status: 'completed', markdown: 'Coverage reached 80%.\nLatency held at 120 ms.\n', sha256: 'unused' }),
      docsRoot: async () => null, attachment: () => null,
    });
    const record = packet.files.find((f) => f.name.startsWith('run-'))!;
    const lineOf = (text: string): number => record.bytes.toString('utf8').split('\n').findIndex((l) => l.includes(text)) + 1;
    // The repository the document was first drafted from, with the line its existing citation names.
    const repo = join(dir, 'widgets');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'perf.md'), '# Perf\n\nThe API serves 450 requests per second.\n');
    // The document's lineage: v0 only (the keep check's own garden answers are not what this test is about).
    const docsRoot = join(dir, 'docs');
    mkdirSync(join(docsRoot, 'deck'), { recursive: true });
    writeFileSync(join(docsRoot, 'deck', '_v0.html'), '<html><body><p>start</p></body></html>');
    writeFileSync(join(docsRoot, 'deck', 'versions.json'), JSON.stringify({ head: 0, versions: [{ version: 0, parent: null, html_file: '_v0.html' }] }));
    const out = join(dir, 'revised.html');
    const notes = join(dir, 'revised.notes.json');
    writeFileSync(notes, JSON.stringify({ left_out: [], sources: [{ token: 'run:evidence', used: true }], assumptions: [] }));
    const keep = {
      gardenRoot: () => '/garden',
      run: async (argv: string[]) => (argv.includes('map')
        ? { stdout: JSON.stringify({ ok: true, map: { texts: {}, attrs: {}, gone: [], added: [], order: null, labels: {} }, entries: [] }), code: 0 }
        : { stdout: JSON.stringify({ ok: true, kept: 0, violations: [] }), code: 0 }),
    };
    const guard = async (recordCite: string) => {
      writeFileSync(out, '<html><body>' +
        '<p data-source="docs/perf.md:3">The API serves 450 requests per second.</p>' +
        `<p data-source="${recordCite}">Coverage reached 80%.</p></body></html>`);
      return guardRefine({
        outPath: out, notesPath: notes, runId: RUN, docsRoot, doc: 'deck', base: 0, allow: [], allowOf: () => [],
        claims: {
          files: packet.files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes.length })),
          packetBytes: (name) => packet.files.find((f) => f.name === name)!.bytes,
          repos: [{ name: 'widgets', rootPath: repo }],
        },
      }, { floor: { gardenRoot: () => garden }, garden: keep });
    };
    const good = await guard(`${record.name}:${lineOf('Coverage reached 80%')}`);
    expect(good, good.ok ? '' : good.reason).toMatchObject({ ok: true });
    const wrongLine = await guard(`${record.name}:${lineOf('Latency held')}`);
    expect(wrongLine).toMatchObject({ ok: false, reason: expect.stringContaining('cite-off') });
    const madeUp = await guard('run-invented-x.md:1');
    expect(madeUp).toMatchObject({ ok: false, reason: expect.stringContaining('dangling-source') });
    // garden#1530 (garden#1550): a citation that leaves the folders is refused even when the file it names carries the
    // text word for word. Checked once the garden in use has that fix (the claims scan names `escaped-source`).
    if (gardenConfines(garden)) {
      const forged = join(dir, 'forged.md');
      writeFileSync(forged, 'Coverage reached 80%.\n');
      for (const cite of [`${forged}:1`, '../forged.md:1']) {
        expect(await guard(cite), cite).toMatchObject({ ok: false, reason: expect.stringContaining('escaped-source') });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
