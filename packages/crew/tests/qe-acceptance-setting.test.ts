// The daemon's QE acceptance setting (`SystemSettings.qeAcceptance`, api-types 0.120.0).
//
// What must hold, and what these tests pin:
//   - 'required' (the default; absent and anything unknown read the same) changes nothing;
//   - 'off' skips QE acceptance on every launch of a workflow that requires it and that neither
//     skips nor forces it, through the engine's own skip, with a reason naming the setting — at the
//     ONE launch choke point (CoreAdapter.launchRun), so every path that launches is labelled alike;
//   - a workflow that does not require QE acceptance gets no skip (the engine refuses a skip there);
//   - a launch's own skip reason or force still wins;
//   - POST /runs deliverGate 'auto' on a QE workflow is allowed under 'off' (unless the launch forces);
//   - PUT /settings admits only 'required' | 'off' (400 otherwise) from a person; GET /health reports it;
//   - a hand-edited settings file with another value reads as 'required'.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { LaunchOptions } from 'wicked-core-ts';
import { CoreAdapter, addonSupportsQeOverride } from '../src/core/adapter.js';
import { DEFAULT_SETTINGS } from '../src/core/types.js';
import {
  QE_OFF_REASON,
  launchRequiresQe,
  qeAcceptanceMode,
  qeSettingSkipReason,
} from '../src/core/qe-acceptance-setting.js';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import { removeScratch } from './setup/scratch.js';

const QE_DEF = { id: 'qe-gated', phases: [], required_instruments: ['distinct_evaluator', 'judge', 'qe_acceptance'] };
const PLAIN_DEF = { id: 'recon', phases: [], required_instruments: ['distinct_evaluator', 'judge'] };
const defs = (id: string) => (id === 'qe-gated' ? QE_DEF : id === 'recon' ? PLAIN_DEF : null);

describe('the setting, read', () => {
  it("anything but 'off' is 'required' (fail closed)", () => {
    expect(qeAcceptanceMode({ qeAcceptance: 'off' })).toBe('off');
    for (const v of [undefined, 'required', 'OFF', false, 0, null]) expect(qeAcceptanceMode({ qeAcceptance: v })).toBe('required');
    expect(qeAcceptanceMode(null)).toBe('required');
    expect(qeAcceptanceMode(undefined)).toBe('required');
    expect(DEFAULT_SETTINGS.qeAcceptance).toBe('required');
  });

  it('a workflow requires QE acceptance when it is a QE preset or its def declares qe_acceptance', async () => {
    const src = { getWorkflow: defs };
    for (const w of ['feature', 'migration', 'bug', 'mcp-server', 'qe-gated']) expect(await launchRequiresQe(src, w), w).toBe(true);
    for (const w of ['recon', 'unknown', undefined]) expect(await launchRequiresQe(src, w), String(w)).toBe(false);
    // A def shadowing a built-in preset's name never speaks for the preset the engine runs.
    expect(await launchRequiresQe({ getWorkflow: () => ({ required_instruments: [] }) }, 'bug')).toBe(true);
  });

  it('a preset resolves first, as the engine does: a saved preset by its own instruments, a built-in by the table', async () => {
    const presets: Record<string, { name: string; created_by: string; required_instruments?: string[] }> = {
      'qe-gated': { name: 'qe-gated', created_by: 'studio' }, // a saved preset WITHOUT qe shadows the def that declares it
      'my-ship': { name: 'my-ship', created_by: 'studio', required_instruments: ['qe_acceptance'] },
      feature: { name: 'feature', created_by: 'builtin' },
      chat: { name: 'chat', created_by: 'builtin' },
    };
    const seen: Array<[string, string | undefined]> = [];
    const src = { getWorkflow: defs, presetNamed: async (n: string, p?: string) => { seen.push([n, p]); return presets[n] ?? null; } };
    expect(await launchRequiresQe(src, 'qe-gated', 'proj-1')).toBe(false);
    expect(await launchRequiresQe(src, 'my-ship')).toBe(true);
    expect(await launchRequiresQe(src, 'feature')).toBe(true);
    expect(await launchRequiresQe(src, 'chat')).toBe(false);
    expect(await launchRequiresQe(src, 'recon')).toBe(false); // no preset: the def decides
    expect(seen[0]).toEqual(['qe-gated', 'proj-1']); // the launch's project scope
    // A preset read that fails falls back to the table and the def.
    expect(await launchRequiresQe({ getWorkflow: defs, presetNamed: async () => { throw new Error('x'); } }, 'qe-gated')).toBe(true);
  });

  it("'off' adds the skip only to a QE launch that neither skips nor forces", () => {
    expect(qeSettingSkipReason('off', {}, true)).toBe(QE_OFF_REASON);
    expect(qeSettingSkipReason('off', {}, false)).toBeUndefined();
    expect(qeSettingSkipReason('off', { forceQeAcceptance: true }, true)).toBeUndefined();
    expect(qeSettingSkipReason('off', { skipQeAcceptanceReason: 'mine' }, true)).toBeUndefined();
    expect(qeSettingSkipReason('required', {}, true)).toBeUndefined();
    expect(QE_OFF_REASON).toMatch(/qeAcceptance: 'off'/);
  });
});

describe('CoreAdapter.launchRun applies the setting (every launch path crosses it)', () => {
  let dir: string;
  let adapter: CoreAdapter;
  let launched: LaunchOptions[];
  let mode: unknown;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qe-setting-launch-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    launched = [];
    mode = 'off';
    (adapter as unknown as { core: Record<string, unknown> }).core['launchRun'] = (opts: LaunchOptions) => {
      launched.push(opts);
      return Promise.resolve(opts.sessionId);
    };
    adapter.getSettings = async () => ({ ...DEFAULT_SETTINGS, qeAcceptance: mode as 'off' });
    const served = adapter.getWorkflow.bind(adapter);
    adapter.getWorkflow = (id: string) => (defs(id) as never) ?? served(id);
  });

  afterEach(() => {
    adapter.close();
    removeScratch(dir);
  });

  const launch = (extra: Record<string, unknown>) =>
    adapter.launchRun({ problem: 'p', sessionId: `s-${launched.length}`, clisJson: '[]', ...extra });

  it.skipIf(!addonSupportsQeOverride())("'off': a QE workflow launch carries the setting's skip reason", async () => {
    await launch({ workflow: 'qe-gated' });
    expect(launched[0]!.skipQeAcceptanceReason).toBe(QE_OFF_REASON);
    expect(launched[0]!.forceQeAcceptance).toBeUndefined();
  });

  it.skipIf(!addonSupportsQeOverride())("'off': a launch that does not require QE acceptance gets no skip (the engine would refuse it)", async () => {
    await launch({ workflow: 'recon' });
    await launch({});
    for (const o of launched) expect(o.skipQeAcceptanceReason).toBeUndefined();
  });

  it.skipIf(!addonSupportsQeOverride())("'off': the launch's own force or skip wins", async () => {
    await launch({ workflow: 'qe-gated', forceQeAcceptance: true });
    await launch({ workflow: 'qe-gated', skipQeAcceptanceReason: 'docs-only' });
    expect(launched[0]!.forceQeAcceptance).toBe(true);
    expect(launched[0]!.skipQeAcceptanceReason).toBeUndefined();
    expect(launched[1]!.skipQeAcceptanceReason).toBe('docs-only');
  });

  it("'required' (and an unreadable setting) adds nothing", async () => {
    mode = 'required';
    await launch({ workflow: 'qe-gated' });
    adapter.getSettings = async () => { throw new Error('unreadable'); };
    await launch({ workflow: 'qe-gated' });
    for (const o of launched) expect(o.skipQeAcceptanceReason).toBeUndefined();
  });
});

describe('the settings file: a hand-edited value other than required|off reads as required', () => {
  const prior = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qe-setting-file-')); });
  afterEach(() => {
    if (prior === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
    else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = prior;
    removeScratch(dir);
  });

  it('reads off as off, and garbage as the default', async () => {
    const file = join(dir, 'settings.json');
    process.env['WICKED_CREW_SYSTEM_SETTINGS'] = file;
    const a = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    try {
      writeFileSync(file, JSON.stringify({ qeAcceptance: 'off' }));
      expect((await a.getSettings()).qeAcceptance).toBe('off');
      writeFileSync(file, JSON.stringify({ qeAcceptance: 'disabled' }));
      expect(qeAcceptanceMode(await a.getSettings())).toBe('required');
    } finally {
      a.close();
    }
  });
});

describe('the routes', () => {
  function build(qeAcceptance: unknown) {
    const launched: Array<Record<string, unknown>> = [];
    const updates: unknown[] = [];
    const a = Fastify({ logger: false });
    // `x-actor: <kind>:<trust>` stands in for the auth hook (as tests/editors.test.ts does).
    a.decorateRequest('actor', null as unknown as never);
    a.addHook('onRequest', async (req) => {
      const h = req.headers['x-actor'];
      if (typeof h === 'string') {
        const [kind, trust] = h.split(':');
        (req as unknown as { actor: unknown }).actor = { id: `${kind}-1`, kind, trust };
      }
    });
    registerRoutes(a, {
      getWorkflow: defs,
      listWorkflows: () => BUILTIN_WORKFLOWS,
      getSettings: async () => ({ ...DEFAULT_SETTINGS, ...(qeAcceptance !== undefined ? { qeAcceptance } : {}) }),
      updateSettings: vi.fn(async (patch: Record<string, unknown>) => { updates.push(patch); return { ...DEFAULT_SETTINGS, ...patch }; }),
      ping: vi.fn().mockResolvedValue('ok'),
      launchRun: vi.fn(async (input: Record<string, unknown>) => { launched.push(input); return 'x'; }),
    } as unknown as CoreAdapter, new GateCache(), new ElicitationCache());
    return { a, launched, updates };
  }

  it("deliverGate 'auto' on a QE workflow: 400 under 'required', 201 under 'off', 400 under 'off' with a force", async () => {
    const req = build('required');
    await req.a.ready();
    const body = { problem: 'p', workflow: 'qe-gated', deliverGate: 'auto', clisJson: '[]' };
    expect((await req.a.inject({ method: 'POST', url: '/api/v1/runs', payload: body })).statusCode).toBe(400);
    await req.a.close();
    const off = build('off');
    await off.a.ready();
    const ok = await off.a.inject({ method: 'POST', url: '/api/v1/runs', payload: body });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(off.launched[0]!['autoDeliver']).toBe(true);
    const forced = await off.a.inject({ method: 'POST', url: '/api/v1/runs', payload: { ...body, forceQeAcceptance: true } });
    expect(forced.statusCode).toBe(400);
    expect(forced.json().error).toMatch(/requires QE acceptance/);
    expect(off.launched).toHaveLength(1);
    await off.a.close();
  });

  it.skipIf(!addonSupportsQeOverride())('codex r1 P1: one settings read per launch — the skip rides the launch with its unattended delivery, never re-derived later', async () => {
    const { a, launched } = build('off');
    await a.ready();
    const res = await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'p', workflow: 'qe-gated', deliverGate: 'auto', clisJson: '[]' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(launched[0]).toMatchObject({ autoDeliver: true, skipQeAcceptanceReason: QE_OFF_REASON });
    // A launch that is not QE work carries no skip under 'off' (the engine would refuse it).
    await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'p', workflow: 'recon', clisJson: '[]' } });
    expect('skipQeAcceptanceReason' in launched[1]!).toBe(false);
    // The operator's own reason wins over the setting's.
    await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'p', workflow: 'qe-gated', clisJson: '[]', skipQeAcceptance: { reason: 'mine' } } });
    expect(launched[2]!['skipQeAcceptanceReason']).toBe('mine');
    await a.close();
  });

  it('GET /health reports the setting', async () => {
    for (const [stored, want] of [['off', 'off'], ['required', 'required'], [undefined, 'required'], ['junk', 'required']] as const) {
      const { a } = build(stored);
      await a.ready();
      const h = (await a.inject({ method: 'GET', url: '/api/v1/health' })).json() as { capabilities: { qeAcceptance?: string } };
      expect(h.capabilities.qeAcceptance, String(stored)).toBe(want);
      await a.close();
    }
  });

  it("PUT /settings admits 'required' | 'off' and refuses anything else by name", async () => {
    const { a, updates } = build(undefined);
    await a.ready();
    for (const v of ['off', 'required']) {
      const r = await a.inject({ method: 'PUT', url: '/api/v1/settings', payload: { qeAcceptance: v } });
      expect(r.statusCode, r.body).toBe(200);
    }
    expect(updates).toEqual([{ qeAcceptance: 'off' }, { qeAcceptance: 'required' }]);
    for (const v of ['disabled', true, null, '']) {
      const r = await a.inject({ method: 'PUT', url: '/api/v1/settings', payload: { qeAcceptance: v } });
      expect(r.statusCode, JSON.stringify(v)).toBe(400);
      expect(r.json().error).toMatch(/qeAcceptance must be 'required' or 'off'/);
    }
    expect(updates).toHaveLength(2);
    await a.close();
  });

  it('only a person may change it: a worker or system actor gets 403 and nothing is written', async () => {
    const { a, updates } = build(undefined);
    await a.ready();
    for (const who of ['agent:operator', 'system:admin', 'human:observer']) {
      const r = await a.inject({ method: 'PUT', url: '/api/v1/settings', headers: { 'x-actor': who }, payload: { qeAcceptance: 'off' } });
      expect(r.statusCode, who).toBe(403);
    }
    expect(updates).toEqual([]);
    const ok = await a.inject({ method: 'PUT', url: '/api/v1/settings', headers: { 'x-actor': 'human:operator' }, payload: { qeAcceptance: 'off' } });
    expect(ok.statusCode, ok.body).toBe(200);
    await a.close();
  });
});
