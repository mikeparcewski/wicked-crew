// EP-C4 — the interactive-theme seam (DES-artifact-editor-plugins §7.6): `theme.learned` → one
// governed run → tokens validated for SHAPE, every value's GRAMMAR and the CONTRAST → written
// THROUGH interactive (PUT /d/:doc/api/theme/learned {tokens, apply:true}). Invalid shape, a
// bad-grammar value (`;}`) and low contrast are each refused with a status.posted error and nothing
// is written; valid tokens make one theme version.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, WorkflowDef } from '../src/core/types.js';
import { INTERACTIVE_PRODUCER, STATUS_POSTED } from '../src/interactive/draft-events.js';
import {
  INTERACTIVE_THEME_BUS_FILTER,
  INTERACTIVE_THEME_WORKFLOW,
  INTERACTIVE_THEME_WORKFLOW_DEF,
  THEME_LEARNED,
  checkThemeContrast,
  checkThemeTokens,
  collectThemeResult,
  contrastRatio,
  isShadow,
  parseColor,
  parseThemeLearned,
  startInteractiveThemeSubscriber,
  themeHandoffKey,
  themeProblem,
  validateThemeTokens,
} from '../src/interactive/theme-events.js';
import { removeScratch } from './setup/scratch.js';

const TOKENS = {
  name: 'acme-light',
  colors: {
    background: '#FFFFFF',
    surface: '#F8FAFC',
    primary: '#1E3A5F',
    secondary: '#2563EB',
    accent: '#0891B2',
    text_primary: '#1E293B',
    text_secondary: '#64748B',
    text_muted: '#94A3B8',
    border: '#E2E8F0',
    success: '#059669',
    warning: '#D97706',
    error: '#DC2626',
  },
  fonts: { heading: 'Inter, Helvetica', body: 'Inter', mono: "'JetBrains Mono', monospace" },
  sizes: { title: '44px', subtitle: '26px', heading: '34px', subheading: '22px', body: '18px', caption: '13px', small: '11px' },
  spacing: { margin: '48px', gap_large: '32px', gap_medium: '24px', gap_small: '16px', gap_xs: '8px' },
  card: { background: '#FFFFFF', border_radius: '8px', padding: '24px', shadow: '0 1px 3px rgba(0,0,0,0.1)' },
};

const learnedPayload = {
  document_id: 'q3-board-deck',
  render_path: '/abs/docs/q3-board-deck/theme/source.pdf',
  format: 'pdf',
  url: 'https://acme.example/brand',
  ts: '2026-10-03T14:00:00Z',
};

describe('parseThemeLearned', () => {
  it('accepts interactive\'s theme.learned (pdf or image render, absolute path, a ts) and carries url/project when present', () => {
    expect(parseThemeLearned(THEME_LEARNED, learnedPayload)).toEqual({
      documentId: 'q3-board-deck',
      renderPath: '/abs/docs/q3-board-deck/theme/source.pdf',
      format: 'pdf',
      url: 'https://acme.example/brand',
      ts: '2026-10-03T14:00:00Z',
    });
    expect(parseThemeLearned(THEME_LEARNED, { ...learnedPayload, url: undefined, format: 'image', project_id: 'p1' })).toMatchObject({ format: 'image', projectId: 'p1' });
  });

  it('refuses other types, a bad doc id, a relative render path, an unknown format or a missing ts', () => {
    expect(parseThemeLearned('wicked.interactive.theme.requested', learnedPayload)).toBeNull();
    expect(parseThemeLearned(THEME_LEARNED, { ...learnedPayload, document_id: '../x' })).toBeNull();
    expect(parseThemeLearned(THEME_LEARNED, { ...learnedPayload, render_path: 'theme/source.pdf' })).toBeNull();
    expect(parseThemeLearned(THEME_LEARNED, { ...learnedPayload, format: 'svg' })).toBeNull();
    expect(parseThemeLearned(THEME_LEARNED, { ...learnedPayload, ts: '' })).toBeNull();
  });

  it('keys the handoff per doc AND event time, so re-learning later is a fresh handoff', () => {
    expect(themeHandoffKey('d', 't1')).toBe('d:theme:t1');
    expect(themeHandoffKey('d', 't1')).not.toBe(themeHandoffKey('d', 't2'));
  });

  it('the problem is single-line and names the doc, the handoff path, never the tokens', () => {
    const p = themeProblem(parseThemeLearned(THEME_LEARNED, learnedPayload)!, '/tmp/edits/x/handoff.json');
    expect(p).not.toMatch(/[\n\r\t]/);
    expect(p).toContain('"q3-board-deck"');
    expect(p).toContain('/tmp/edits/x/handoff.json');
    expect(p).toContain('acme.example/brand');
  });
});

describe('the interactive-theme workflow def', () => {
  it('is one creator phase, single-line instructions carrying the shape, the grammar and the contrast floor, auto gate, no validator', () => {
    const def = INTERACTIVE_THEME_WORKFLOW_DEF;
    expect(def.id).toBe(INTERACTIVE_THEME_WORKFLOW);
    expect(def.phases).toHaveLength(1);
    const p = def.phases[0]!;
    expect(p.role).toBe('creator');
    expect(p.gate).toBe('auto');
    expect(p.validator_pin).toBeNull();
    expect(p.instructions).not.toMatch(/[\n\r]/);
    for (const key of ['text_primary', 'gap_xs', 'border_radius', 'output_path', '4.5:1', 'url(']) expect(p.instructions).toContain(key);
    expect(INTERACTIVE_THEME_BUS_FILTER).toBe('wicked.interactive.theme.learned@wicked-interactive');
  });
});

describe('the token grammar (interactive\'s, ported field for field) + contrast', () => {
  it('accepts the DEFAULT_THEME shape', () => {
    expect(checkThemeTokens(TOKENS)).toEqual({ ok: true });
    expect(validateThemeTokens(TOKENS)).toEqual({ ok: true });
  });

  it('refuses a value outside the grammar — the `;}` injection, url(, a bare word colour, a length without a unit, an unknown key, a missing group', () => {
    const bad = (patch: (t: typeof TOKENS) => unknown) => checkThemeTokens(patch(structuredClone(TOKENS)));
    expect(bad((t) => ({ ...t, colors: { ...t.colors, primary: 'red;}body{background:url(https://x/?d=1)' } }))).toEqual({ ok: false, reason: 'theme-rejected:value-outside-grammar:colors.primary' });
    expect(bad((t) => ({ ...t, card: { ...t.card, shadow: 'url(https://x/a.png)' } }))).toEqual({ ok: false, reason: 'theme-rejected:value-outside-grammar:card.shadow' });
    expect(bad((t) => ({ ...t, colors: { ...t.colors, accent: 'teal' } }))).toEqual({ ok: false, reason: 'theme-rejected:value-outside-grammar:colors.accent' });
    expect(bad((t) => ({ ...t, sizes: { ...t.sizes, body: '18' } }))).toEqual({ ok: false, reason: 'theme-rejected:value-outside-grammar:sizes.body' });
    expect(bad((t) => ({ ...t, fonts: { ...t.fonts, body: 'Inter; x' } }))).toEqual({ ok: false, reason: 'theme-rejected:value-outside-grammar:fonts.body' });
    expect(bad((t) => ({ ...t, extra: { a: 1 } }))).toEqual({ ok: false, reason: 'theme-rejected:unknown-key:extra' });
    expect(bad((t) => ({ ...t, colors: { ...t.colors, hover: '#fff' } }))).toEqual({ ok: false, reason: 'theme-rejected:unknown-key:colors.hover' });
    expect(bad((t) => {
      const { card: _card, ...rest } = t;
      return rest;
    })).toEqual({ ok: false, reason: 'theme-rejected:missing-group:card' });
    expect(bad((t) => {
      const { gap_xs: _g, ...spacing } = t.spacing;
      return { ...t, spacing };
    })).toEqual({ ok: false, reason: 'theme-rejected:missing-key:spacing.gap_xs' });
    expect(checkThemeTokens('nope')).toEqual({ ok: false, reason: 'theme-rejected:not-an-object' });
    expect(checkThemeTokens({ ...TOKENS, name: 'bad<name>' })).toEqual({ ok: false, reason: 'theme-rejected:value-outside-grammar:name' });
  });

  it('shadows: none, one or two `<x> <y> [blur] <colour>` entries; commas inside a colour function are not separators', () => {
    expect(isShadow('none')).toBe(true);
    expect(isShadow('0 1px 3px rgba(0,0,0,0.1)')).toBe(true);
    expect(isShadow('0 1px 3px rgba(0,0,0,0.1), 0 4px 12px #00000022')).toBe(true);
    expect(isShadow('0 1px #000')).toBe(true);
    expect(isShadow('0 1px 3px 4px 5px #000')).toBe(false);
    expect(isShadow('0 1px 3px red')).toBe(false);
    expect(isShadow('a, b, c')).toBe(false);
  });

  it('contrast: WCAG ratios for hex, rgb() and hsl(); text on background below 4.5:1 is refused; a var() colour cannot be checked and is refused honestly', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#fff', 'rgb(0, 0, 0)')).toBeCloseTo(21, 1);
    expect(contrastRatio('hsl(0, 0%, 0%)', '#fff')).toBeCloseTo(21, 1);
    expect(parseColor('var(--wi-bg)')).toBeNull();
    expect(checkThemeContrast(TOKENS)).toEqual({ ok: true });
    const low = { ...TOKENS, colors: { ...TOKENS.colors, text_primary: '#BBBBBB' } };
    const r = checkThemeContrast(low);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/^contrast-too-low:1\.92:1/); // #BBBBBB on white
    const unknowable = { ...TOKENS, colors: { ...TOKENS.colors, background: 'var(--wi-bg)' } };
    expect((checkThemeContrast(unknowable) as { reason: string }).reason).toMatch(/^contrast-not-checkable/);
    // The combined check: grammar first, then contrast.
    expect(validateThemeTokens(low)).toMatchObject({ ok: false });
  });

  it('collectThemeResult: a missing or non-JSON file is a reason, not a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-theme-collect-'));
    expect(collectThemeResult(join(dir, 'nope.json'))).toMatchObject({ error: expect.stringContaining('no token file') });
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(collectThemeResult(join(dir, 'bad.json'))).toMatchObject({ error: expect.stringContaining('not JSON') });
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(TOKENS));
    expect(collectThemeResult(join(dir, 'ok.json'))).toEqual({ tokens: TOKENS });
    removeScratch(dir);
  });
});

interface FakeAdapter {
  launches: LaunchRunInput[];
  registered: WorkflowDef[];
  fire: (event: CoreEvent) => void;
  asAdapter(): CoreAdapter;
}

function fakeAdapter(): FakeAdapter {
  const listeners = new Set<(e: CoreEvent) => void>();
  const state: FakeAdapter = {
    launches: [],
    registered: [],
    fire: (event) => {
      for (const l of listeners) l(event);
    },
    asAdapter() {
      return {
        registerWorkflow: async (def: WorkflowDef) => {
          state.registered.push(def);
          return def.id;
        },
        launchRun: async (input: LaunchRunInput) => {
          state.launches.push(input);
          return input.sessionId;
        },
        onEvent: (listener: (e: CoreEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as CoreAdapter;
    },
  };
  return state;
}

const SEATS = JSON.stringify([{ key: 'stub', display_name: 'Stub', binary: 'stub', headless_invocation: 'stub {PROMPT}' }]);

async function waitFor(cond: () => boolean, ms = 5000, step = 25): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

describe('startInteractiveThemeSubscriber (real bus, fake engine, stub writer)', () => {
  let dir: string;
  let busDb: string;
  let subs: { stop(): Promise<void> | void }[];
  let probeEvents: Array<{ event_type: string; payload: Record<string, unknown>; producer_id?: string | null }>;
  let puts: Array<{ documentId: string; projectId: string | undefined; tokens: Record<string, unknown> }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-ite-'));
    busDb = join(dir, 'bus.db');
    subs = [];
    probeEvents = [];
    puts = [];
  });
  afterEach(async () => {
    for (const s of subs) await s.stop();
    removeScratch(dir);
  });

  async function emitLearned(bus: typeof import('wicked-bus'), overrides: Record<string, unknown> = {}) {
    const db = bus.openDb({ db_path: busDb });
    const config = bus.loadConfig({ db_path: busDb });
    bus.emit(db, config, {
      event_type: THEME_LEARNED,
      domain: 'wicked-interactive',
      subdomain: 'theme',
      payload: { ...learnedPayload, render_path: join(dir, 'source.pdf'), ...overrides },
      producer_id: 'wi-service',
    });
  }

  function armProbe(bus: typeof import('wicked-bus')) {
    const db = bus.openDb({ db_path: busDb });
    const probe = bus.subscribe({
      db,
      plugin: 'test-probe',
      filter: '*@wicked-interactive',
      cursor_init: 'oldest',
      pollIntervalMs: 25,
      maxRetries: 0,
      handler: (e) => {
        probeEvents.push({ event_type: e.event_type, payload: e.payload as Record<string, unknown>, producer_id: (e as { producer_id?: string | null }).producer_id ?? null });
      },
    });
    subs.push(probe);
  }

  async function arm(engine: FakeAdapter, write: (tokens: Record<string, unknown>) => Promise<{ version: number | null }> = async () => ({ version: 7 })) {
    const sub = await startInteractiveThemeSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      editDir: join(dir, 'edits'),
      clisJson: SEATS,
      putLearnedTheme: async (documentId, projectId, tokens) => {
        puts.push({ documentId, projectId, tokens });
        return write(tokens);
      },
      log: () => {},
    });
    expect(sub).not.toBeNull();
    subs.push(sub!);
    return sub!;
  }

  const statuses = () => probeEvents.filter((e) => e.event_type === STATUS_POSTED && e.producer_id === INTERACTIVE_PRODUCER).map((e) => e.payload);

  it('answers theme.learned with ONE governed run, hands off by file, validates, writes THROUGH interactive and announces the version', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    await arm(engine);
    armProbe(bus);
    expect(engine.registered.map((w) => w.id)).toEqual([INTERACTIVE_THEME_WORKFLOW]);

    await emitLearned(bus);
    await waitFor(() => engine.launches.length === 1);
    const launch = engine.launches[0]!;
    expect(launch.workflow).toBe(INTERACTIVE_THEME_WORKFLOW);
    expect(launch.clisJson).toBe(SEATS);
    expect(launch.projectId).toBeUndefined();
    const runDir = join(dir, 'edits', 'q3-board-deck-theme-2026-10-03T14-00-00Z');
    expect(launch.extraWriteRoots).toEqual([runDir]);
    const handoff = JSON.parse(readFileSync(join(runDir, 'handoff.json'), 'utf8')) as { render_path: string; output_path: string; shape: unknown };
    expect(handoff.render_path).toBe(join(dir, 'source.pdf'));
    expect(handoff.output_path).toBe(join(runDir, 'theme.tokens.json'));
    expect(launch.requireDeliverables).toEqual([handoff.output_path]);
    expect(launch.problem).toContain(join(runDir, 'handoff.json'));
    await waitFor(() => statuses().some((s) => s['state'] === 'processing'));

    writeFileSync(handoff.output_path, JSON.stringify(TOKENS));
    engine.fire({ type: 'sessionCompleted', session: launch.sessionId } as CoreEvent);
    await waitFor(() => puts.length === 1);
    expect(puts[0]).toEqual({ documentId: 'q3-board-deck', projectId: undefined, tokens: TOKENS });
    await waitFor(() => statuses().some((s) => s['state'] === 'complete'));
    const done = statuses().find((s) => s['state'] === 'complete')!;
    expect(done['version']).toBe(7);
    expect(done['document_id']).toBe('q3-board-deck');
    expect(String(done['message'])).toMatch(/version 7/);

    // A replay of the same event is ignored; a later learn (new ts) is a fresh handoff.
    await emitLearned(bus);
    await new Promise((r) => setTimeout(r, 200));
    expect(engine.launches).toHaveLength(1);
    await emitLearned(bus, { ts: '2026-10-03T15:00:00Z' });
    await waitFor(() => engine.launches.length === 2);
  });

  it('refuses a bad-grammar value, a wrong shape and low contrast — each with a status.posted error, and interactive is never written', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    await arm(engine);
    armProbe(bus);
    const cases: Array<[string, unknown, RegExp]> = [
      ['2026-10-03T16:00:00Z', { ...TOKENS, colors: { ...TOKENS.colors, primary: 'red;}body{background:url(https://x/)' } }, /theme-rejected:value-outside-grammar:colors.primary/],
      ['2026-10-03T16:01:00Z', { colors: TOKENS.colors }, /theme-rejected:missing-group:fonts/],
      ['2026-10-03T16:02:00Z', { ...TOKENS, colors: { ...TOKENS.colors, text_primary: '#CCCCCC' } }, /contrast-too-low/],
    ];
    for (const [ts, tokens, expected] of cases) {
      const before = engine.launches.length;
      await emitLearned(bus, { ts });
      await waitFor(() => engine.launches.length === before + 1);
      const launch = engine.launches[before]!;
      const out = (launch.requireDeliverables as string[])[0]!;
      writeFileSync(out, JSON.stringify(tokens));
      engine.fire({ type: 'sessionCompleted', session: launch.sessionId } as CoreEvent);
      await waitFor(() => statuses().some((s) => s['state'] === 'error' && expected.test(String(s['message']))));
    }
    expect(puts).toHaveLength(0);
    expect(statuses().filter((s) => s['state'] === 'complete')).toHaveLength(0);
  });

  it('a run that fails, or a writer interactive refuses, is an error status — the document is unchanged', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    await arm(engine, async () => {
      throw new Error('interactive refused the theme (400): theme tokens refused: theme-rejected:x');
    });
    armProbe(bus);
    await emitLearned(bus, { ts: '2026-10-03T17:00:00Z' });
    await waitFor(() => engine.launches.length === 1);
    engine.fire({ type: 'stepFailed', session: engine.launches[0]!.sessionId, detail: 'the seat wrote nothing' } as unknown as CoreEvent);
    engine.fire({ type: 'sessionFailed', session: engine.launches[0]!.sessionId } as CoreEvent);
    await waitFor(() => statuses().some((s) => s['state'] === 'error' && /failed/.test(String(s['message'])) && /the seat wrote nothing/.test(String(s['message']))));
    await emitLearned(bus, { ts: '2026-10-03T17:01:00Z' });
    await waitFor(() => engine.launches.length === 2);
    const launch = engine.launches[1]!;
    writeFileSync((launch.requireDeliverables as string[])[0]!, JSON.stringify(TOKENS));
    engine.fire({ type: 'sessionCompleted', session: launch.sessionId } as CoreEvent);
    await waitFor(() => statuses().some((s) => s['state'] === 'error' && /did not take it/.test(String(s['message']))));
    expect(puts).toHaveLength(1);
  });
});
