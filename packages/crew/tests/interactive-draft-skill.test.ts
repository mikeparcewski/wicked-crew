// interactive/draft-skill.ts — the wicked-garden-draft quality floor as the seams hand it to the
// engine: stamped ONLY when the published snapshot holds the skill (the engine refuses a skill_ref
// it lacks at plan time), the page budget read from the brief/style, and the task clause that
// names the self-check's inputs the way the skill's `## Runtime` block expects.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';
import { INTERACTIVE_CHAT_WORKFLOW_DEF, startInteractiveChatSubscriber } from '../src/interactive/chat-events.js';
import { INTERACTIVE_DRAFT_WORKFLOW_DEF } from '../src/interactive/draft-events.js';
import { INTERACTIVE_EDIT_WORKFLOW_DEF } from '../src/interactive/edit-events.js';
import {
  DRAFT_SELF_CHECK_LAUNCHER,
  DRAFT_SKILL,
  draftQualityClause,
  draftSkillArmLine,
  pageBudgetFor,
  withDraftSkill,
} from '../src/interactive/draft-skill.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import type { SkillsStore } from '../src/skills/store.js';
import { removeScratch } from './setup/scratch.js';

describe('withDraftSkill', () => {
  it('held ⇒ every AGENT phase of draft/edit/chat carries skill_ref wicked-garden-draft; the shared def is never mutated', () => {
    for (const def of [INTERACTIVE_DRAFT_WORKFLOW_DEF, INTERACTIVE_EDIT_WORKFLOW_DEF, INTERACTIVE_CHAT_WORKFLOW_DEF]) {
      const out = withDraftSkill(def, true);
      expect(out.phases.length).toBe(def.phases.length);
      for (const p of out.phases) expect(p.skill_ref).toBe(DRAFT_SKILL);
      for (const p of def.phases) expect(p.skill_ref).toBeNull();
      expect(out.id).toBe(def.id);
    }
  });
  it('not held ⇒ the SAME def object, skill_ref null (the engine would refuse a ref the snapshot lacks)', () => {
    expect(withDraftSkill(INTERACTIVE_DRAFT_WORKFLOW_DEF, false)).toBe(INTERACTIVE_DRAFT_WORKFLOW_DEF);
  });
  it('a tool-executor phase takes no skill', () => {
    const def: WorkflowDef = {
      ...INTERACTIVE_DRAFT_WORKFLOW_DEF,
      phases: [
        ...INTERACTIVE_DRAFT_WORKFLOW_DEF.phases,
        { ...INTERACTIVE_DRAFT_WORKFLOW_DEF.phases[1]!, id: 'floor', executor: { type: 'tool', cmd: ['true'] } },
      ],
    };
    const out = withDraftSkill(def, true);
    expect(out.phases[2]!.skill_ref).toBeNull();
    expect(out.phases[1]!.skill_ref).toBe(DRAFT_SKILL);
  });
});

describe('pageBudgetFor', () => {
  it('the brief\'s named count wins, exactly ("two pages", "2-page", "one-pager")', () => {
    expect(pageBudgetFor('a two-page brochure about wicked-studio', 'brochure')).toEqual({ pages: 2, exact: true, source: 'brief' });
    expect(pageBudgetFor('Two pages, A4, print-ready', 'brochure')).toEqual({ pages: 2, exact: true, source: 'brief' });
    expect(pageBudgetFor('a 3-page leaflet', 'brochure')).toEqual({ pages: 3, exact: true, source: 'brief' });
    expect(pageBudgetFor('a one-pager for the CTO', 'web')).toEqual({ pages: 1, exact: true, source: 'brief' });
    expect(pageBudgetFor('4 printed pages please', 'doc')).toEqual({ pages: 4, exact: true, source: 'brief' });
  });
  it('style defaults: brochure → 2 exact; web/doc/ppt → no page budget; unknown style → unknown', () => {
    expect(pageBudgetFor('a brochure about crew', 'brochure')).toEqual({ pages: 2, exact: true, source: 'style-default' });
    expect(pageBudgetFor('a landing page', 'web')).toEqual({ pages: null, exact: false, source: 'style-default' });
    expect(pageBudgetFor('a memo', 'doc')).toEqual({ pages: null, exact: false, source: 'style-default' });
    expect(pageBudgetFor('a deck', 'ppt')).toEqual({ pages: null, exact: false, source: 'style-default' });
    expect(pageBudgetFor('something', 'poster')).toEqual({ pages: null, exact: false, source: 'unknown' });
  });
  it('never reads a count out of unrelated numbers ("page 3 of the README", "10 pages of logs" is a count though)', () => {
    expect(pageBudgetFor('summarise page 3 of the README', 'doc').pages).toBeNull();
    expect(pageBudgetFor('600 pages', 'doc').pages).toBeNull(); // over the 60 ceiling → not a budget
  });
});

describe('draftQualityClause', () => {
  it('names the budget, the snapshot(s) as --repo, the exact launcher command on the SAVED file, and the verdict discipline — one line', () => {
    const clause = draftQualityClause('/inbox/doc/draft.html', { pages: 2, exact: true, source: 'brief' }, ['/inbox/doc/repos/wicked-studio'], { style: 'brochure' });
    expect(clause).not.toMatch(/\n/);
    expect(clause).toContain('page budget = 2 printed pages, exactly (the brief names it)');
    expect(clause).toContain(`${DRAFT_SELF_CHECK_LAUNCHER} /inbox/doc/draft.html --pages 2 --exact --render --repo /inbox/doc/repos/wicked-studio`);
    expect(clause).toMatch(/PASS/);
    expect(clause).toMatch(/UNVERIFIED page count must be disclosed/);
    expect(clause).toContain('"$WICKED_GARDEN_ROOT/scripts/wicked-garden" run scripts/draft/self_check.py');
  });
  it('a web page: --no-pages --mode screen --min-font-pt 0; a deck: the outline\'s slide count; a revision: no --repo, revision wording', () => {
    expect(draftQualityClause('/o.html', { pages: null, exact: false, source: 'style-default' }, [], { style: 'web' })).toContain('--no-pages --render --mode screen --min-font-pt 0');
    expect(draftQualityClause('/o.html', { pages: null, exact: false, source: 'style-default' }, [], { style: 'ppt' })).toContain('--pages <the slide count the outline fixed> --exact');
    const rev = draftQualityClause('/o.html', { pages: null, exact: false, source: 'unknown' }, [], { revision: true });
    expect(rev).toContain('A revision can re-introduce a defect');
    expect(rev).not.toContain('--repo');
    expect(rev).toContain('no repository snapshot rides a revision');
  });
});

describe('draftSkillArmLine', () => {
  it('says which way the gate went and, when not held, why and what arms it', () => {
    expect(draftSkillArmLine('interactive-draft', true)).toMatch(/carry skill_ref 'wicked-garden-draft'/);
    const off = draftSkillArmLine('interactive-draft', false);
    expect(off).toMatch(/does not hold 'wicked-garden-draft'/);
    expect(off).toMatch(/12\.35\.0/);
    expect(off).toMatch(/refuse every run at plan time/);
  });
});

describe('SkillsRuntime.holdsSkill', () => {
  function runtimeWith(state: string, skills: Record<string, { enabled: boolean }>, manifestThrows = false): SkillsRuntime {
    const store = { manifest: () => { if (manifestThrows) throw new Error('boom'); return { skills }; } } as unknown as SkillsStore;
    const rt = new SkillsRuntime({ store, log: () => {}, bootSnapshot: undefined });
    (rt as unknown as { lastHealth: { state: string } }).lastHealth = { state, root: null, current: null, engineInput: null, stateHome: null, findings: [] } as never;
    return rt;
  }
  it('true only for a PUBLISHED snapshot holding the skill enabled; false on every other state, a missing/disabled entry, or an unreadable manifest', () => {
    expect(runtimeWith('published', { [DRAFT_SKILL]: { enabled: true } }).holdsSkill(DRAFT_SKILL)).toBe(true);
    expect(runtimeWith('published', { [DRAFT_SKILL]: { enabled: false } }).holdsSkill(DRAFT_SKILL)).toBe(false);
    expect(runtimeWith('published', {}).holdsSkill(DRAFT_SKILL)).toBe(false);
    expect(runtimeWith('fallback', { [DRAFT_SKILL]: { enabled: true } }).holdsSkill(DRAFT_SKILL)).toBe(false);
    expect(runtimeWith('blocked', { [DRAFT_SKILL]: { enabled: true } }).holdsSkill(DRAFT_SKILL)).toBe(false);
    expect(runtimeWith('published', { [DRAFT_SKILL]: { enabled: true } }, true).holdsSkill(DRAFT_SKILL)).toBe(false);
  });
});

describe('a seam registers the STAMPED def only when the snapshot holds the skill (chat seam over a real bus)', () => {
  let dir: string;
  let subs: Array<{ stop(): Promise<void> | void }>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-draft-skill-'));
    subs = [];
  });
  afterEach(async () => {
    for (const s of subs) await s.stop();
    removeScratch(dir);
  });
  function engine(): { registered: WorkflowDef[]; logs: string[]; adapter: CoreAdapter } {
    const registered: WorkflowDef[] = [];
    const logs: string[] = [];
    const adapter = {
      registerWorkflow: async (def: WorkflowDef) => { registered.push(def); return def.id; },
      launchRun: async () => 'r',
      onEvent: () => () => undefined,
    } as unknown as CoreAdapter;
    return { registered, logs, adapter };
  }
  it('held → skill_ref on both phases + the arm log says so; not held (default) → null + the log names the fix', async () => {
    const held = engine();
    const sub1 = await startInteractiveChatSubscriber(held.adapter, {
      dbPath: join(dir, 'bus.db'), pollIntervalMs: 25, ledgerPath: join(dir, 'l1.json'), chatDir: join(dir, 'c1'),
      clisJson: '[]', log: (m) => held.logs.push(m), skillHeld: (name) => name === DRAFT_SKILL,
    });
    subs.push(sub1!);
    expect(held.registered[0]!.phases.map((p) => p.skill_ref)).toEqual([DRAFT_SKILL, DRAFT_SKILL]);
    expect(held.logs.some((l) => l.includes("carry skill_ref 'wicked-garden-draft'"))).toBe(true);

    const bare = engine();
    const sub2 = await startInteractiveChatSubscriber(bare.adapter, {
      dbPath: join(dir, 'bus2.db'), pollIntervalMs: 25, ledgerPath: join(dir, 'l2.json'), chatDir: join(dir, 'c2'),
      clisJson: '[]', log: (m) => bare.logs.push(m),
    });
    subs.push(sub2!);
    expect(bare.registered[0]!.phases.map((p) => p.skill_ref)).toEqual([null, null]);
    expect(bare.logs.some((l) => l.includes("does not hold 'wicked-garden-draft'"))).toBe(true);
  });
});
