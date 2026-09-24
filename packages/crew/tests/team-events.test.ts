// DES-TEAMING-002 T1 (wicked-core `src/team/events.rs`): the `wicked.team.*` wire contract as crew
// reads it.
//
// - The §4.1 key vectors: crew's JS `deterministicKey` must equal wicked-core's
//   `crate::bus::deterministic_key` byte for byte. The expected values are the DES's own vectors
//   and the per-fixture keys wicked-core's `every_fixture_keys_to_its_fixed_value` pins, so the
//   two implementations are held to one table.
// - The engine's round-trip fixtures, typed against the api-types mirror (a COMPILE-TIME check in
//   `tests/fixtures/team-events.fixtures.ts`, enforced by `npm run typecheck`) and compared by
//   value with the JSON copied from wicked-core.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type * as Wire from 'wicked-crew-api-types';
import { deterministicKey, teamKey } from '../src/team/key.js';
import { TEAM_EVENT_FIXTURES } from './fixtures/team-events.fixtures.js';

const ENGINE_FIXTURES = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/team-events.json', import.meta.url)), 'utf8'),
) as { type: string; payload: Record<string, unknown> }[];

// The payload map covers every type, and nothing else (compile-time, both directions).
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const PAYLOAD_KEYS_ARE_THE_TYPES: Exact<keyof Wire.TeamEventPayloads, Wire.TeamEventType> = true;

/** The key parts after `["team", type, run_id]`, per DES-002 §6.1. */
function keyParts(ev: Wire.TeamBusEvent): string[] {
  const p = ev.payload;
  const oa = (): string[] => [String(p.ord), String(p.attempt)];
  switch (ev.event_type) {
    case 'wicked.team.path.started':
    case 'wicked.team.path.ended':
      return [];
    case 'wicked.team.path.scored':
      return [ev.payload.score_source];
    case 'wicked.team.plan.proposed':
    case 'wicked.team.plan.refused':
      return [ev.payload.proposal_id];
    case 'wicked.team.plan.revised':
    case 'wicked.team.plan.accepted':
      return [String(ev.payload.plan_rev)];
    case 'wicked.team.member.joined':
    case 'wicked.team.member.left':
      return [...oa(), ev.payload.member_id, String(ev.payload.open_seq)];
    case 'wicked.team.step.claimed':
    case 'wicked.team.step.completed':
      return [ev.payload.step_id, String(p.attempt), p.by];
    case 'wicked.team.step.reviewed':
      return [ev.payload.step_id, String(p.attempt)];
    case 'wicked.team.checkpoint.reached':
      return [...oa(), String(ev.payload.seq)];
    case 'wicked.team.finding.raised':
    case 'wicked.team.finding.settled':
      return [...oa(), String(ev.payload.raise_seq)];
    case 'wicked.team.advice.delivered':
      return [...oa(), String(ev.payload.raise_seq), ev.payload.delivery_id];
    case 'wicked.team.advice.answered':
      return [...oa(), String(ev.payload.raise_seq), ev.payload.answered_in];
    case 'wicked.team.help.requested':
      return [ev.payload.help_id];
    case 'wicked.team.help.answered':
      return [ev.payload.help_id, ev.payload.answer_id];
    case 'wicked.team.change.requested':
      return [ev.payload.change_id];
    case 'wicked.team.council.called':
    case 'wicked.team.council.ruled':
      return [...oa(), ev.payload.subject];
    case 'wicked.team.ledger.folded':
      return oa();
    case 'wicked.team.gate.opened':
    case 'wicked.team.gate.decided':
      return [ev.payload.gate_id];
  }
}

// wicked-core `every_fixture_keys_to_its_fixed_value`, in fixture order.
const ENGINE_KEYS = [
  'd47a180bea33813b621ae21635872c07',
  '49cf8532bcd55d8613fe98e4909b616a',
  'abcb4cad4ddddea1920b580a3f47e897',
  'ba2dac6452b8d4b4bca27ab4c4eea758',
  '17305523b085e10692dc99691e34d4d8',
  'bf2c504130d772320a0ad921012c21c9',
  '4d31d91a66891cf6ffb8489c95275951',
  '2ed493eac380400a34dd36321c8159e7',
  '7c68ff2c79f4bec348c53d1e689904fd',
  'ea3c05d48212f591ea5fb9184f0497fd',
  '88796d03e5083035922afa595f7601a6',
  'a98075c153327e4d23ac01d121c67d7c',
  '60f6be8bfd3e0ad6b36657142a523dac',
  'f8cd6dff40853156099bcea2130ea3ce',
  '453dd2cb14b57a48509ab0f5bb58383a',
  '6b80d638ce979d7c6255fb9ea9b7abef',
  '60389a008abcb3363ac57ff2c2ead046',
  '0aea19144388cbdf69ef875b7903b665',
  '2cd8416f64142620632ff34f38bb60a4',
  '42861609786df934ff8b443786dad111',
  '5673facd459e952c91630af43e74ab7f',
  '3cd042600abfa95e861a07361ff18478',
  '2ea3f95feb57f7679a1e15145a12ee63',
  '92b2c6be477ba34bde95e2fa31b371b4',
  'bf5d42dcb030bded0b3740751133ac53',
  '0bae9761177641edfae23fdee995e9e0',
  '8d1d1f6e960c61422d2c33cff742f6c5',
  'e4b13241087ea34f29f7508ab089b566',
  '8741e4e2305194adf64fedb610c1d12a',
];

describe('team keys (DES-TEAMING-002 §4.1)', () => {
  it('reproduces the DES vectors byte for byte', () => {
    expect(
      deterministicKey(['team', 'wicked.team.finding.raised', 'run-1', 'f-3fa9c2e1d0b4a7e6']),
    ).toBe('f8289d402fc42823fd875fcf4456bd8f');
    expect(teamKey('wicked.team.path.started', 'run-1')).toBe('25ea4932f42b6e22f1aacd16bc3dcdd9');
    // The failure the vector exists to catch: a `\0`-join without the trailing NUL.
    const joined = ['team', 'wicked.team.finding.raised', 'run-1', 'f-3fa9c2e1d0b4a7e6'].join('\0');
    const wrong = createHash('sha256').update(joined, 'utf8').digest().subarray(0, 16).toString('hex');
    expect(wrong).toBe('fed61d5909428bb7aec506ad09dc86d1');
  });

  it('keys every engine fixture to the value wicked-core pins', () => {
    expect(TEAM_EVENT_FIXTURES.map((ev) => teamKey(ev.event_type, ev.payload.run_id, keyParts(ev)))).toEqual(
      ENGINE_KEYS,
    );
  });
});

describe('team payloads (DES-TEAMING-002 §6)', () => {
  it('the typed fixtures equal the engine fixtures by value', () => {
    expect(PAYLOAD_KEYS_ARE_THE_TYPES).toBe(true);
    expect(TEAM_EVENT_FIXTURES.map((ev) => ({ type: ev.event_type, payload: ev.payload }))).toEqual(ENGINE_FIXTURES);
  });

  it('covers all 25 types, every one four segments under wicked.team', () => {
    const types = new Set(TEAM_EVENT_FIXTURES.map((ev) => ev.event_type));
    expect(types.size).toBe(25);
    for (const t of types) expect(t).toMatch(/^wicked\.team\.[a-z_]+\.[a-z_]+$/);
  });
});
