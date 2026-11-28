// crew#1885: who may read a run's delivery text with no operator bearer: that run's own deliver script, by the read key
// in the 0600 file the script crew composes for its deliver unit names (never a value on its command line, codex-check
// on crew#1946), or a post-hoc delivery's, registered with its text while it runs.

import { chmodSync, lstatSync, mkdtempSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deliverTextAllowed, grantPostHocDeliverText, postHocDeliverText } from '../src/core/deliver-grants.js';
import { deliverKeyDir, deliverKeyMatches, dropDeliverKey, mintDeliverKey, readDeliverKey } from '../src/core/deliver-key.js';
import { deliverPrScript } from '../src/core/deliver.js';
import { deliverableFloorPhase } from '../src/core/deliverable-floor.js';
import { surveyStateHome } from '../src/projects/state-home-preflight.js';
import { crewStateHome } from '../src/projects/state-home.js';

const RUN = 'run-1885';

/** The deliver unit as the engine holds it: `<run>:deliver`, running the script `deliverPrScript` writes, with its key. */
function deliverUnit(status: string | null | undefined, keyFile = mintDeliverKey()) {
  return {
    unit: { id: `${RUN}:deliver`, status, tool_cmd: ['bash', '-lc', deliverPrScript('ship it', { runId: RUN, keyFile, apiOrigin: 'http://127.0.0.1:7701' })] },
    key: readDeliverKey(keyFile)!,
    keyFile,
  };
}

describe('deliver read keys (crew#1885)', () => {
  it('mints a 64-hex key in a fresh 0600 file of a 0700 dir under the crew state home, read back only from there', () => {
    const path = mintDeliverKey();
    expect(path.startsWith(`${deliverKeyDir()}/`)).toBe(true);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(deliverKeyDir()).mode & 0o777).toBe(0o700);
    const key = readDeliverKey(path)!;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(mintDeliverKey()).not.toBe(path);
    expect(deliverKeyMatches(path, key)).toBe(true);
    expect(deliverKeyMatches(path, key.toUpperCase())).toBe(true);
    expect(deliverKeyMatches(path, 'f'.repeat(64))).toBe(false);
    // Widened to others: no key.
    chmodSync(path, 0o640);
    expect(readDeliverKey(path)).toBeNull();
    dropDeliverKey(path);
    expect(readDeliverKey(path)).toBeNull();
  });

  it('reads no file outside its dir, by another name, or through a symlink', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'deliver-key-'));
    const outside = join(elsewhere, `${'a'.repeat(32)}.key`);
    writeFileSync(outside, `${'b'.repeat(64)}\n`, { mode: 0o600 });
    expect(readDeliverKey(outside)).toBeNull();
    // A literal traversal (never normalized first, codex r2) names no key file.
    const real = mintDeliverKey();
    expect(readDeliverKey(`${deliverKeyDir()}/../deliver-keys/${basename(real)}`)).toBeNull();
    expect(readDeliverKey(real)).not.toBeNull();
    const link = join(deliverKeyDir(), `${'c'.repeat(32)}.key`);
    mintDeliverKey(); // the dir exists
    symlinkSync(outside, link);
    try {
      expect(readDeliverKey(link)).toBeNull();
    } finally {
      unlinkSync(link);
    }
    const misnamed = join(deliverKeyDir(), 'not-a-key.txt');
    writeFileSync(misnamed, `${'b'.repeat(64)}\n`, { mode: 0o600 });
    expect(readDeliverKey(misnamed)).toBeNull();
    unlinkSync(misnamed);
  });
});

describe('the key dir (crew#1885, codex r2)', () => {
  it('sits under a registered state-home entry no worker reads, so it adds nothing the engine\'s preflight refuses launches over', () => {
    mintDeliverKey();
    expect(dirname(deliverKeyDir())).toBe(join(crewStateHome(), 'artifacts'));
    const unregistered = surveyStateHome(crewStateHome()).map((e) => e.name);
    expect(unregistered).not.toContain('deliver-keys');
    expect(unregistered).not.toContain('artifacts');
  });

  it('counts no key once the dir is open to others or is a symlink, and mints into neither', () => {
    const path = mintDeliverKey();
    const key = readDeliverKey(path)!;
    chmodSync(deliverKeyDir(), 0o755);
    expect(readDeliverKey(path)).toBeNull();
    // `artifacts` above it writable by others: someone could move the key dir aside, so no key counts (codex r2).
    chmodSync(deliverKeyDir(), 0o700);
    chmodSync(dirname(deliverKeyDir()), 0o777);
    try {
      expect(readDeliverKey(path)).toBeNull();
    } finally {
      chmodSync(dirname(deliverKeyDir()), 0o755);
    }
    chmodSync(deliverKeyDir(), 0o755);
    // Minting narrows a dir of the daemon user's own back to 0700.
    mintDeliverKey();
    expect(lstatSync(deliverKeyDir()).mode & 0o777).toBe(0o700);
    expect(readDeliverKey(path)).toBe(key);
    // The dir swapped for a symlink to a dir elsewhere: no key reads, and nothing is minted through it.
    const aside = `${deliverKeyDir()}.aside`;
    renameSync(deliverKeyDir(), aside);
    const elsewhere = mkdtempSync(join(tmpdir(), 'deliver-keys-elsewhere-'));
    chmodSync(elsewhere, 0o700);
    symlinkSync(elsewhere, deliverKeyDir());
    try {
      renameSync(join(aside, basename(path)), join(elsewhere, basename(path)));
      expect(readDeliverKey(path)).toBeNull();
      expect(() => mintDeliverKey()).toThrow(/not the daemon user's own private dir/);
    } finally {
      unlinkSync(deliverKeyDir());
      renameSync(aside, deliverKeyDir());
    }
  });
});

describe('deliver text grants (crew#1885)', () => {
  it('allows the key in the file the dispatched deliver unit\'s script names, in either case, and no other', () => {
    const d = deliverUnit('distributed');
    const units = [{ id: `${RUN}:fix`, status: 'done', tool_cmd: null }, d.unit];
    expect(deliverTextAllowed(units, d.key, false)).toBe(true);
    expect(deliverTextAllowed(units, d.key.toUpperCase(), false)).toBe(true);
    expect(deliverTextAllowed(units, 'f'.repeat(64), false)).toBe(false);
    expect(deliverTextAllowed(units, d.key.slice(0, 32), false)).toBe(false);
    // Found by catalog entry too, as deliverUnitOf finds a deliver phase under another id.
    expect(deliverTextAllowed([{ ...d.unit, id: `${RUN}:ship`, catalog: 'deliver' }], d.key, false)).toBe(true);
    // The key is the file's: once the file is gone, nothing on the command line stands in for it.
    dropDeliverKey(d.keyFile);
    expect(deliverTextAllowed(units, d.key, false)).toBe(false);
  });

  it('reads the key file\'s id whichever separator the script\'s path uses (a Windows state home writes backslashes, codex r2)', () => {
    const d = deliverUnit('distributed');
    const id = basename(d.keyFile, '.key');
    const script = d.unit.tool_cmd[2]!.replace(/^DELIVER_KEY_FILE='[^']+'$/m, `DELIVER_KEY_FILE='C:\\Users\\op\\.wicked-crew\\artifacts\\deliver-keys\\${id}.key'`);
    expect(script).toContain(`deliver-keys\\${id}.key'`);
    expect(deliverTextAllowed([{ ...d.unit, tool_cmd: ['bash', '-lc', script] }], d.key, false)).toBe(true);
  });

  it('never takes a value off the command line: the script text holds neither the key nor anything that reads as one', () => {
    const d = deliverUnit('distributed');
    const script = d.unit.tool_cmd[2]!;
    expect(script).not.toContain(d.key);
    for (const value of script.match(/[0-9a-fA-F]{16,}/g) ?? []) expect(deliverTextAllowed([d.unit], value, false), value.length.toString()).toBe(false);
  });

  it('counts only while the script can still run: not done (or refused, as the gate retry re-runs it) on a live run; never once done, of an unknown status, or once the run has ended', () => {
    const d = deliverUnit('distributed');
    expect(deliverTextAllowed([d.unit], d.key, false)).toBe(true);
    // Approving the deliver-refusal gate re-runs the same script while the engine still marks the unit rejected.
    expect(deliverTextAllowed([{ ...d.unit, status: 'rejected' }], d.key, false)).toBe(true);
    for (const status of ['done', 'failed', 'cancelled', 'Pending', '', null, undefined]) {
      expect(deliverTextAllowed([{ ...d.unit, status }], d.key, false), String(status)).toBe(false);
    }
    for (const status of ['pending', 'distributed', 'rejected']) {
      expect(deliverTextAllowed([{ ...d.unit, status }], d.key, true), `${status}, run ended`).toBe(false);
    }
  });

  it('counts the deliver unit a send-back left pending, as it counted it before the send-back (crew#2004)', () => {
    // The engine's own writes: the plan stamps every unit `distributed` (wicked-core src/pipeline.rs:849,
    // `apply_distributions`), and a send-back's rewind stamps every unit after its target `pending` (wicked-core
    // src/actor.rs:24049, `rewind_writes`; the target itself goes back to `distributed`). Dispatch writes no status, so
    // the deliver unit runs its script still reading `pending` once the run had any rework (the release cert: 4 of 4).
    const d = deliverUnit('pending');
    const units = [
      { id: `${RUN}:fix`, status: 'done', tool_cmd: null },
      { id: `${RUN}:review`, status: 'done', tool_cmd: null },
      d.unit,
    ];
    expect(deliverTextAllowed(units, d.key, false)).toBe(true);
    // The same unit before any send-back reads `distributed`, and counts the same.
    expect(deliverTextAllowed([{ ...d.unit, status: 'distributed' }], d.key, false)).toBe(true);
    // Still only its own key, and nothing once the run has ended.
    expect(deliverTextAllowed(units, 'f'.repeat(64), false)).toBe(false);
    expect(deliverTextAllowed(units, d.key, true)).toBe(false);
  });

  it('never reads a key file out of another command: a deliverable path a worker declared, or a deliver-looking script on another unit (codex r1)', () => {
    const d = deliverUnit('distributed');
    // The real deliverable-floor command, whose argv carries the declared paths verbatim.
    const floor = deliverableFloorPhase([`DELIVER_KEY_FILE='${d.keyFile}'`, d.keyFile], 1).executor;
    const floorCmd = floor !== undefined && floor.type === 'tool' ? floor.cmd : [];
    expect(floorCmd.join(' ')).toContain(d.keyFile);
    expect(deliverTextAllowed([{ id: `${RUN}:verify-deliverables`, status: 'distributed', tool_cmd: floorCmd }], d.key, false)).toBe(false);
    // The deliver unit, but not crew's script shape (another program, or the path not on a line of its own).
    expect(deliverTextAllowed([{ id: `${RUN}:deliver`, status: 'distributed', tool_cmd: floorCmd }], d.key, false)).toBe(false);
    expect(deliverTextAllowed([{ id: `${RUN}:deliver`, status: 'distributed', tool_cmd: ['bash', '-lc', `echo DELIVER_KEY_FILE='${d.keyFile}'`] }], d.key, false)).toBe(false);
    expect(deliverTextAllowed([{ id: `${RUN}:deliver`, status: 'distributed', tool_cmd: ['sh', '-c', d.unit.tool_cmd[2]!] }], d.key, false)).toBe(false);
    // Crew's script on a unit that is not the deliver phase.
    expect(deliverTextAllowed([{ ...d.unit, id: `${RUN}:build` }], d.key, false)).toBe(false);
  });

  it('answers a post-hoc delivery\'s own text for its run only, while it is held, counting overlapping holds', () => {
    const first = mintDeliverKey();
    const second = mintDeliverKey();
    const k1 = readDeliverKey(first)!;
    const k2 = readDeliverKey(second)!;
    expect(postHocDeliverText(RUN, k1)).toBeNull();
    const r1 = grantPostHocDeliverText(RUN, first, 'title\n\nbody one\n');
    const r1b = grantPostHocDeliverText(RUN, first, 'title\n\nbody one again\n');
    const r2 = grantPostHocDeliverText(RUN, second, 'title\n\nbody two\n');
    expect(postHocDeliverText(RUN, k1)).toBe('title\n\nbody one again\n');
    expect(postHocDeliverText(RUN, k2.toUpperCase())).toBe('title\n\nbody two\n');
    expect(postHocDeliverText(RUN, 'f'.repeat(64))).toBeNull();
    expect(postHocDeliverText('another-run', k1)).toBeNull();
    r1();
    r1(); // a release is idempotent: the second hold still stands
    expect(postHocDeliverText(RUN, k1)).not.toBeNull();
    r1b();
    expect(postHocDeliverText(RUN, k1)).toBeNull();
    r2();
    expect(postHocDeliverText(RUN, k2)).toBeNull();
  });
});
