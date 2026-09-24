// DES-TEAMING-002 T0 — the engine-bus handoff decision, every branch: an unavailable bus dominates.
import { describe, expect, it } from 'vitest';

import { engineBusHandoff, type EngineBusInput } from '../src/core/engine-bus.js';

const CREW = '/s/core.db.bus/bus.db';
const LEGACY = '/s/bus.db';
const DOWN = (dbPath: string) => ({ dbPath, reason: 'ENOTDIR' });
const base: EngineBusInput = {
  engineRule: true,
  engineExec: false,
  busDbPath: CREW,
  busUnavailable: undefined,
  preRuleExecBusDbPath: LEGACY,
  preRuleExecUnavailable: undefined,
};

describe('engineBusHandoff (T0)', () => {
  it('an engine with the rule gets the crew bus; exec follows the flag', () => {
    expect(engineBusHandoff(base)).toEqual({ busDbPath: CREW, engineExec: false });
    expect(engineBusHandoff({ ...base, engineExec: true })).toEqual({ busDbPath: CREW, engineExec: true });
  });
  it('an engine with the rule and an unopenable crew bus gets none, exec off, the reason kept', () => {
    expect(engineBusHandoff({ ...base, engineExec: true, busUnavailable: DOWN(CREW) })).toEqual({
      busUnavailable: DOWN(CREW),
      engineExec: false,
    });
  });
  it('an engine without the rule gets no bus on a default boot (the crew bus notice is kept)', () => {
    expect(engineBusHandoff({ ...base, engineRule: false })).toEqual({ engineExec: false });
    expect(engineBusHandoff({ ...base, engineRule: false, busUnavailable: DOWN(CREW) })).toEqual({
      busUnavailable: DOWN(CREW),
      engineExec: false,
    });
  });
  it('an engine without the rule under --engine-exec gets the pre-T0 exec bus', () => {
    expect(engineBusHandoff({ ...base, engineRule: false, engineExec: true })).toEqual({
      busDbPath: LEGACY,
      engineExec: true,
    });
  });
  it('an engine without the rule, --engine-exec and an unopenable exec bus: the failure dominates', () => {
    expect(
      engineBusHandoff({ ...base, engineRule: false, engineExec: true, preRuleExecUnavailable: DOWN(LEGACY) }),
    ).toEqual({ busUnavailable: DOWN(LEGACY), engineExec: false });
  });
});
