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

// coord r2 on crew#1853: the repository moves on between the draft and the refine (a line inserted above a cited line,
// a cited file renamed). The citations the revision carries over unchanged were checked when they were written; the
// refine judges only the ones it adds or changes, so a repository-grounded document can still be refined.
it.skipIf(!REQUIRED && !garden)('a refine lands when the repository changed under the citations it carries over, and still refuses one it adds', async () => {
  if (!garden) throw new Error('WICKED_CLAIMS_FLOOR=required but WICKED_GARDEN_ROOT is missing (expected a wicked-garden checkout)');
  const dir = mkdtempSync(join(tmpdir(), 'crew-refine-carried-'));
  try {
    const repo = join(dir, 'widgets');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    // The repository as the draft saw it: both citations below were right then.
    writeFileSync(join(repo, 'docs', 'perf.md'), '# Perf\n\nThe API serves 450 requests per second.\n');
    writeFileSync(join(repo, 'docs', 'uptime.md'), 'Uptime was 99.9% last quarter.\n');
    const carried =
      '<p data-source="docs/perf.md:3">The API serves 450 requests per second.</p>' +
      '<p data-source="docs/uptime.md:1">Uptime was 99.9% last quarter.</p>';
    const docsRoot = join(dir, 'docs');
    mkdirSync(join(docsRoot, 'deck'), { recursive: true });
    writeFileSync(join(docsRoot, 'deck', '_v0.html'), `<html><body>${carried}</body></html>`);
    writeFileSync(join(docsRoot, 'deck', 'versions.json'), JSON.stringify({ head: 0, versions: [{ version: 0, parent: null, html_file: '_v0.html' }] }));
    // Then the repository moved on: one line above the cited one, and the uptime file renamed.
    writeFileSync(join(repo, 'docs', 'perf.md'), '# Perf\n\nMeasured on the staging cluster.\nThe API serves 450 requests per second.\n');
    rmSync(join(repo, 'docs', 'uptime.md'));
    writeFileSync(join(repo, 'docs', 'availability.md'), 'Uptime was 99.9% last quarter.\n');
    const out = join(dir, 'revised.html');
    const notes = join(dir, 'revised.notes.json');
    writeFileSync(notes, JSON.stringify({ left_out: [], sources: [], assumptions: [] }));
    const keep = {
      gardenRoot: () => '/garden',
      run: async (argv: string[]) => (argv.includes('map')
        ? { stdout: JSON.stringify({ ok: true, map: { texts: {}, attrs: {}, gone: [], added: [], order: null, labels: {} }, entries: [] }), code: 0 }
        : { stdout: JSON.stringify({ ok: true, kept: 0, violations: [] }), code: 0 }),
    };
    const guard = async (body: string) => {
      writeFileSync(out, `<html><body>${body}</body></html>`);
      return guardRefine({
        outPath: out, notesPath: notes, runId: RUN, docsRoot, doc: 'deck', base: 0, allow: [], allowOf: () => [],
        claims: { files: [], packetBytes: () => Buffer.alloc(0), repos: [{ name: 'widgets', rootPath: repo }] },
      }, { floor: { gardenRoot: () => garden }, garden: keep });
    };
    // The refine rewrote the heading and carried both citations over as they were: it lands, and the check says so.
    const landed = await guard(`<h1>Platform health</h1>${carried}`);
    expect(landed, landed.ok ? '' : landed.reason).toMatchObject({ ok: true });
    if (landed.ok) expect(landed.floor.summary).toContain('carried over');
    // A citation the refine adds is judged against the repository as it is now: a wrong line is refused.
    const added = await guard(`${carried}<p data-source="docs/perf.md:1">The API serves 450 requests per second.</p>`);
    expect(added).toMatchObject({ ok: false, reason: expect.stringContaining('cite-off') });
    // So is a carried citation whose text the refine changed.
    const changed = await guard(carried.replace('450 requests per second.', '450 requests per second at peak.'));
    expect(changed).toMatchObject({ ok: false, reason: expect.stringContaining('cite-off') });
    // And a file the refine newly cites that is not there.
    const gone = await guard(`${carried}<p data-source="docs/latency.md:1">Latency held at 120 ms.</p>`);
    expect(gone).toMatchObject({ ok: false, reason: expect.stringContaining('dangling-source') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// crew#1857: a refine that rewords a carried paragraph whose cited line moved was refused with only "claims: 1
// cite-off", which does not say the repository changed since the draft. The refine writer has no repository folder, so
// asking again gave the same refusal. The refusal now says why, names the citation and the nearest line, and what to do.
it.skipIf(!REQUIRED && !garden)('a refused rewording of a carried citation says the repository changed since the draft (crew#1857)', async () => {
  if (!garden) throw new Error('WICKED_CLAIMS_FLOOR=required but WICKED_GARDEN_ROOT is missing (expected a wicked-garden checkout)');
  const dir = mkdtempSync(join(tmpdir(), 'crew-refine-moved-'));
  try {
    const repo = join(dir, 'widgets');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'perf.md'), '# Perf\n\nThe API serves 450 requests per second.\n');
    const carried = '<p data-source="docs/perf.md:3">The API serves 450 requests per second.</p>';
    const docsRoot = join(dir, 'docs');
    mkdirSync(join(docsRoot, 'deck'), { recursive: true });
    writeFileSync(join(docsRoot, 'deck', '_v0.html'), `<html><body>${carried}</body></html>`);
    writeFileSync(join(docsRoot, 'deck', 'versions.json'), JSON.stringify({ head: 0, versions: [{ version: 0, parent: null, html_file: '_v0.html' }] }));
    // The repository moves on after the draft: a line lands above the cited one.
    writeFileSync(join(repo, 'docs', 'perf.md'), '# Perf\n\nMeasured on the staging cluster.\nThe API serves 450 requests per second.\n');
    const out = join(dir, 'revised.html');
    const notes = join(dir, 'revised.notes.json');
    writeFileSync(notes, JSON.stringify({ left_out: [], sources: [], assumptions: [] }));
    const keep = {
      gardenRoot: () => '/garden',
      run: async (argv: string[]) => (argv.includes('map')
        ? { stdout: JSON.stringify({ ok: true, map: { texts: {}, attrs: {}, gone: [], added: [], order: null, labels: {} }, entries: [] }), code: 0 }
        : { stdout: JSON.stringify({ ok: true, kept: 0, violations: [] }), code: 0 }),
    };
    const guard = async (body: string) => {
      writeFileSync(out, `<html><body>${body}</body></html>`);
      return guardRefine({
        outPath: out, notesPath: notes, runId: RUN, docsRoot, doc: 'deck', base: 0, allow: [], allowOf: () => [],
        claims: { files: [], packetBytes: () => Buffer.alloc(0), repos: [{ name: 'widgets', rootPath: repo }] },
      }, { floor: { gardenRoot: () => garden }, garden: keep });
    };
    // The person asks to reword that paragraph.
    const reworded = await guard(carried.replace('450 requests per second.', '450 requests per second at peak.'));
    expect(reworded.ok).toBe(false);
    const reason = reworded.ok ? '' : reworded.reason;
    expect(reason).toContain('cite-off');
    expect(reason).toContain('changed since the draft');
    expect(reason).toContain('docs/perf.md:3');
    expect(reason).toContain('the nearest matching line is now 4');
    expect(reason).toMatch(/keep that paragraph's wording|new draft/);
    // A citation the refine adds itself, wrong from the start, is refused without that explanation: it is not the
    // repository that moved.
    const added = await guard(`${carried}<p data-source="docs/perf.md:1">The API serves 450 requests per second.</p>`);
    expect(added.ok).toBe(false);
    expect(added.ok ? '' : added.reason).not.toContain('changed since the draft');
    // Nor is a second paragraph the refine adds on the very citation it carried over unchanged (review r1): the one base
    // finding is the carried paragraph's, set aside, and explains nothing else.
    const duplicated = await guard(`${carried}<p data-source="docs/perf.md:3">The API serves 9999 requests per second.</p>`);
    expect(duplicated.ok).toBe(false);
    expect(duplicated.ok ? '' : duplicated.reason).not.toContain('changed since the draft');
    // A reworded carrier beside a new paragraph on the same citation: one base finding explains one refused finding.
    const both = await guard(`${carried.replace('450 requests per second.', '450 requests per second at peak.')}<p data-source="docs/perf.md:3">The API serves 9999 requests per second.</p>`);
    expect(both.ok ? '' : both.reason).toContain('at peak');
    expect(both.ok ? '' : both.reason).not.toContain('9999');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
