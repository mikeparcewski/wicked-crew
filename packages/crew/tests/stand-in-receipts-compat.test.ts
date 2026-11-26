// (DES-STANDIN-001 §9 T-X1, crew#1940) The stand-in receipts crew serves, read by a FROZEN copy of studio's own reader.
// Crew relays the engine's gate frames as they are (`GET /runs/:id/events` adds only `seq`), so the seam is the wire:
// a receipt shape crew passes that studio's reader takes the wrong way ("claude~1 reviewed", a stand-in read as an
// independent review, a delivery that drops a gate's stand-in) fails here, in crew's CI, before a train ships it.
//
// The frozen files are studio main bd0cb132's src/board/assuranceModel.ts and the four modules it imports, copied
// verbatim (their hashes are pinned below: refresh them on purpose, from studio, never by hand). Their wire types
// come from crew's own copy of the contract package (`studio-frozen/api/types.ts`, as studio's src/api/types.ts does).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CoreEvent } from 'wicked-crew-api-types';

import { assuranceKind, deliveryReceiptOf, receiptOf, receiptWords } from './fixtures/studio-frozen/board/assuranceModel.js';

/** The wire: the gate frames of a stand-in run as crew served them (see the fixture's `_source`). */
const wire = JSON.parse(readFileSync(new URL('./fixtures/stand-in-receipts.wire.json', import.meta.url), 'utf8')) as { events: Array<Record<string, unknown>> };
const gate = (ord: number): Record<string, unknown> => {
  const e = wire.events.find((x) => x['type'] === 'gateEvaluated' && x['ord'] === ord);
  if (e === undefined) throw new Error(`no gateEvaluated for ord ${ord}`);
  return e['assurance'] as Record<string, unknown>;
};
const REVIEW_LABEL = "Claude Code stood in for the review, using Claude Code's default model: only Claude Code was signed in";
const JUDGE_LABEL = "Claude Code stood in for the judge, using Claude Code's default model: only Claude Code was signed in";

describe('the frozen studio reader is the copy it says it is', () => {
  it('each frozen file hashes as copied from studio main bd0cb132', () => {
    const pinned: Record<string, string> = {
      'board/actorWords.ts': 'dfcff776c7f09d013fbf6bf4f823d90c708b1472e1f9a5bca5676f88ec0b85ac',
      'board/assuranceModel.ts': '51541d9056557aa6a40beaba19524fa05e01fbae84f3d9745d1efd47c40d2f8e',
      'board/floorOverride.ts': 'e311429f72d49a8f76c9355ee0a0ede05f4355be468987a916f45d5575ca01b1',
      'board/gateOffers.ts': 'be46ea767ceb7f27af64aa3b37f5d323e272e516d3f86920da98dae7b0353e2e',
      'board/responder.ts': '75444a5d4b50a3ea563e950399a3c2b1b12ebde2063ff8a538ed652ac2ea4f25',
      'board/seatNames.ts': 'c46ba6ba5c2563d3614a22fd3c076e684eedabe36004597ae7e9532f9d9cb02c',
    };
    for (const [file, sha] of Object.entries(pinned)) {
      const text = readFileSync(new URL(`./fixtures/studio-frozen/${file}`, import.meta.url));
      expect(createHash('sha256').update(text).digest('hex'), file).toBe(sha);
    }
  });
});

describe('stand-in receipts as crew serves them, read by studio (T-X1)', () => {
  it('all stand-in (ord 3): both roles read as stand-ins with the engine\'s labels; no binding key is named as a reviewer', () => {
    const r = receiptOf(gate(3))!;
    expect(r.evaluator).toBeNull();
    expect(r.judge).toBeNull();
    expect(r.standIns).toEqual([
      { role: 'evaluator', seat: 'claude~1', label: REVIEW_LABEL },
      { role: 'judge', seat: 'claude~2', label: JUDGE_LABEL },
    ]);
    // A stand-in is the same helper checking again: never an independent review, never "only automatic checks".
    expect(assuranceKind(r)).toBe('same-seat');
    const words = receiptWords(r, true);
    expect(words.who).not.toMatch(/claude~\d/u);
    expect(words.who).toContain('evaluated by');
    expect(words.who).toContain('judged by');
  });

  it('a judge stand-in alone (ord 2): one stand-in, the judge', () => {
    const r = receiptOf(gate(2))!;
    expect(r.standIns).toEqual([{ role: 'judge', seat: 'claude~2', label: JUDGE_LABEL }]);
    expect(receiptWords(r, true).who ?? '').not.toMatch(/claude~\d/u);
  });

  it('mixed: a real reviewer beside a stand-in judge reads the reviewer as a seat and only the judge as a stand-in', () => {
    // ord 3's receipt with its evaluator role filled by a real seat, as the engine writes one (wicked-core
    // src/assurance.rs `RoleRecord::real`: filled real, state answered, the seat, no standIn) and names it
    // (`evaluator`, `distinct_evaluator` ran, `independence: mixed`, `independence_of`).
    const base = gate(3);
    const roles = (base['roles'] as Array<Record<string, unknown>>).map((x) => (x['role'] === 'evaluator'
      ? { attempt: x['attempt'], filled: 'real', ord: x['ord'], role: 'evaluator', seat: 'codex', standIn: null, state: 'answered', subject: null }
      : x));
    const mixed = {
      ...base,
      evaluator: 'codex',
      ran: [...(base['ran'] as string[]), 'distinct_evaluator'],
      skipped: (base['skipped'] as Array<Record<string, unknown>>).filter((s) => s['instrument'] !== 'distinct_evaluator'),
      roles,
      independence: 'mixed',
    };
    const r = receiptOf(mixed)!;
    expect(r.evaluator).toBe('codex');
    expect(r.standIns).toEqual([{ role: 'judge', seat: 'claude~2', label: JUDGE_LABEL }]);
    expect(assuranceKind(r)).toBe('independent');
    expect(receiptWords(r, true).who).toContain('evaluated by codex');
  });

  it('no seat-bound role (roles empty, canonical): no stand-in is read, and the legacy fields stand', () => {
    const r = receiptOf({ ...gate(3), roles: [], independence: undefined, standInLabel: undefined, evaluator: 'codex', judge: 'pi' })!;
    expect(r.standIns).toBeUndefined();
    expect(r.evaluator).toBe('codex');
  });

  it('the delivery aggregate lists every gate\'s stand-ins once each', () => {
    const r = deliveryReceiptOf(null, wire.events as unknown as CoreEvent[])!;
    expect(r).not.toBeNull();
    expect(r.standIns).toEqual(expect.arrayContaining([
      { role: 'evaluator', seat: 'claude~1', label: REVIEW_LABEL },
      { role: 'judge', seat: 'claude~2', label: JUDGE_LABEL },
    ]));
    expect(r.standIns).toHaveLength(2);
    expect(receiptWords(r, true).who ?? '').not.toMatch(/claude~\d/u);
  });
});
