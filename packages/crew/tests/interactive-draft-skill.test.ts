// interactive/draft-skill.ts — the wicked-garden-draft quality floor as the seams hand it to the
// engine: the interactive-* presets always run the skill (crew#935; the engine refuses a launch
// whose snapshot lacks it), the page budget read from the brief/style, and the task clause that
// names the self-check's inputs the way the skill's `## Runtime` block expects.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput, WorkflowDef } from '../src/core/types.js';
import { startInteractiveChatSubscriber } from '../src/interactive/chat-events.js';
import {
  DRAFT_SELF_CHECK_LAUNCHER,
  DRAFT_SELF_CHECK_SCRIPT,
  DRAFT_SKILL,
  draftFloorArgv,
  draftFloorVerdict,
  draftQualityClause,
  draftSkillArmLine,
  pageBudgetFor,
  runDraftFloor,
  type PageBudget,
} from '../src/interactive/draft-skill.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import type { SkillsStore } from '../src/skills/store.js';
import { removeScratch } from './setup/scratch.js';

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
  it('says whether the snapshot holds the skill and, when not, that the preset is refused and what fixes it', () => {
    expect(draftSkillArmLine('interactive-draft', true)).toMatch(/preset runs skill 'wicked-garden-draft'/);
    const off = draftSkillArmLine('interactive-draft', false);
    expect(off).toMatch(/does not hold 'wicked-garden-draft'/);
    expect(off).toMatch(/12\.35\.0/);
    expect(off).toMatch(/every run on this seam fails before the document work starts/);
  });
});

describe('SkillsRuntime.holdsSkill', () => {
  // `holdsSkill` reads the PUBLISHED generation's rows (`currentSnapshotSkills`, DES-L6 PR-L6-1 (d) / F-E2E-042) —
  // only enabled skills are ever published, so the stub publishes exactly the enabled entries.
  function runtimeWith(state: string, skills: Record<string, { enabled: boolean }>, manifestThrows = false): SkillsRuntime {
    const published = Object.entries(skills).filter(([, v]) => v.enabled).map(([name]) => name);
    const store = {
      currentSnapshotSkills: () => { if (manifestThrows) throw new Error('boom'); return { gen: 1, skills: published }; },
    } as unknown as SkillsStore;
    const rt = new SkillsRuntime({ store, log: () => {}, bootSnapshot: undefined });
    (rt as unknown as { lastHealth: { state: string } }).lastHealth = { state, root: null, current: null, engineInput: null, stateHome: null, findings: [] } as never;
    return rt;
  }
  it('true only for a PUBLISHED snapshot holding the skill; false on every other state, a skill the generation lacks (missing or disabled at publish), or an unverifiable generation', () => {
    expect(runtimeWith('published', { [DRAFT_SKILL]: { enabled: true } }).holdsSkill(DRAFT_SKILL)).toBe(true);
    expect(runtimeWith('published', { [DRAFT_SKILL]: { enabled: false } }).holdsSkill(DRAFT_SKILL)).toBe(false);
    expect(runtimeWith('published', {}).holdsSkill(DRAFT_SKILL)).toBe(false);
    expect(runtimeWith('fallback', { [DRAFT_SKILL]: { enabled: true } }).holdsSkill(DRAFT_SKILL)).toBe(false);
    expect(runtimeWith('blocked', { [DRAFT_SKILL]: { enabled: true } }).holdsSkill(DRAFT_SKILL)).toBe(false);
    expect(runtimeWith('published', { [DRAFT_SKILL]: { enabled: true } }, true).holdsSkill(DRAFT_SKILL)).toBe(false);
  });
});

describe('a seam registers NO def and always hands the preset the quality clause (crew#935, chat seam over a real bus)', () => {
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
  function engine(): { registered: WorkflowDef[]; launches: LaunchRunInput[]; logs: string[]; adapter: CoreAdapter } {
    const registered: WorkflowDef[] = [];
    const launches: LaunchRunInput[] = [];
    const logs: string[] = [];
    const adapter = {
      registerWorkflow: async (def: WorkflowDef) => { registered.push(def); return def.id; },
      launchRun: async (input: LaunchRunInput) => { launches.push(input); return input.sessionId; },
      onEvent: () => () => undefined,
    } as unknown as CoreAdapter;
    return { registered, launches, logs, adapter };
  }
  it('held or not, nothing is registered; the arm log says which way the snapshot is and names the fix', async () => {
    const held = engine();
    const sub1 = await startInteractiveChatSubscriber(held.adapter, {
      dbPath: join(dir, 'bus.db'), pollIntervalMs: 25, ledgerPath: join(dir, 'l1.json'), chatDir: join(dir, 'c1'),
      clisJson: '[]', log: (m) => held.logs.push(m), skillHeld: (name) => name === DRAFT_SKILL,
    });
    subs.push(sub1!);
    expect(held.registered).toEqual([]);
    expect(held.logs.some((l) => l.includes("preset runs skill 'wicked-garden-draft'"))).toBe(true);

    const bare = engine();
    const sub2 = await startInteractiveChatSubscriber(bare.adapter, {
      dbPath: join(dir, 'bus2.db'), pollIntervalMs: 25, ledgerPath: join(dir, 'l2.json'), chatDir: join(dir, 'c2'),
      clisJson: '[]', log: (m) => bare.logs.push(m),
    });
    subs.push(sub2!);
    expect(bare.registered).toEqual([]);
    expect(bare.logs.some((l) => l.includes("does not hold 'wicked-garden-draft'") && l.includes('every run on this seam fails'))).toBe(true);
  });
});

// ── THE DRAFT FLOOR: crew re-derives the skill's verdict from the artifact (crew#621 / crew#504) ──
//
// Before this, both agent phases of `interactive-draft` gated `ungated: true` and the only thing
// between a breaching document and the user's canvas was the worker's own word: the brochure that
// shipped was a ~3.4-page web layout for a two-page A4 brief, with literal placeholder copy and
// invented "acceptance record" proof rows. Crew cannot pin an engine validator (no vault
// provisioning through napi), so it re-runs the skill's own self-check on the SAVED file and
// judges its report. These pin that judgement.

const EXACT_2: PageBudget = { pages: 2, exact: true, source: 'brief' };
const NO_BUDGET: PageBudget = { pages: null, exact: false, source: 'style-default' };

/** A self-check report shaped like `scripts/draft/self_check.py --json`. */
function report(over: {
  claims?: boolean;
  byKind?: Record<string, number>;
  contrast?: boolean;
  contrastFailures?: number;
  pages?: number | null;
  pagesVerified?: boolean;
} = {}): unknown {
  return {
    check: 'draft-self-check',
    verdict: 'PASS',
    checks: {
      claims: { ok: over.claims ?? true, by_kind: over.byKind ?? {}, findings: [], summary: 'claims: clean' },
      contrast: {
        ok: over.contrast ?? true,
        contrast_failures: over.contrastFailures ?? 0,
        size_failures: 0,
        summary: 'contrast: ok',
      },
      pages: {
        pages: over.pages === undefined ? 2 : over.pages,
        budget: 2,
        exact: true,
        verified: over.pagesVerified ?? true,
        summary: 'pages: 2 (chrome-render) vs budget = 2 — within',
      },
    },
  };
}

describe('draftFloorVerdict — the rule named, and only what a count without a render can prove', () => {
  it('a clean report passes', () => {
    expect(draftFloorVerdict(report(), EXACT_2)).toEqual({
      verdict: 'pass',
      breaches: [],
      summary: 'the draft floor met every rule on the saved document',
    });
  });

  it('failed claims are a breach naming the finding kinds and the rule (crew#504: placeholder copy, unlabelled mock evidence)', () => {
    const v = draftFloorVerdict(report({ claims: false, byKind: { placeholder: 1, 'mock-unlabelled': 2 } }), EXACT_2);
    expect(v.verdict).toBe('fail');
    expect(v.breaches).toHaveLength(1);
    expect(v.breaches[0]).toContain('1 placeholder');
    expect(v.breaches[0]).toContain('2 mock-unlabelled');
    expect(v.breaches[0]).toMatch(/no placeholder copy may ship/);
  });

  it('failed contrast is a breach naming the pair count and the floor', () => {
    const v = draftFloorVerdict(report({ contrast: false, contrastFailures: 3 }), EXACT_2);
    expect(v.verdict).toBe('fail');
    expect(v.breaches[0]).toContain('3 text/background pair(s) below the 4.5:1 floor');
  });

  it('a page count ABOVE the budget is a page-size/count breach — even unverified, because the count is a lower bound', () => {
    const v = draftFloorVerdict(report({ pages: 4, pagesVerified: false }), EXACT_2);
    expect(v.verdict).toBe('fail');
    expect(v.breaches[0]).toContain('budget is 2 printed page(s) exactly');
    expect(v.breaches[0]).toContain('declares 4');
  });

  it('a page count BELOW an exact budget is NOT a breach — only a render can judge that, so it is reported unverified', () => {
    const v = draftFloorVerdict(report({ pages: 1, pagesVerified: false }), EXACT_2);
    expect(v.verdict).toBe('unverified');
    expect(v.breaches).toEqual([]);
    expect(v.summary).toMatch(/page count is UNVERIFIED/);
  });

  it('the check\'s own FAIL on an UNMEASURED page count below an exact budget is not a refusal — the floor says "unmeasured", never "no" (crew#812)', () => {
    // The exact answer `self_check.py --pages 2 --exact --json` gives WITHOUT --render for run 40ade5a9's
    // deliverable (W12 chapter 32): verdict FAIL, failed ["pages"], pages 1 (html-estimate), verified false —
    // the same file with --render answers PASS, pages 2. Red before crew#812: the pages rule correctly pushed
    // nothing (1 ≤ 2) and the `verdict === 'FAIL'` fallback then refused the document on the one check the
    // module note says this floor cannot judge, so every exact-N-page document whose structural estimate is
    // below N was unpublishable.
    const refusedWithoutRender = {
      ...(report({ pages: 1, pagesVerified: false }) as object),
      verdict: 'FAIL',
      failed: ['pages'],
      checks: {
        ...((report({ pages: 1, pagesVerified: false }) as { checks: object }).checks),
        pages: { pages: 1, budget: 2, exact: true, verified: false, within_budget: false, summary: 'pages: 1 (html-estimate) vs budget = 2 — EXCEEDED — UNVERIFIED (no render)' },
      },
    };
    const v = draftFloorVerdict(refusedWithoutRender, EXACT_2);
    expect(v.verdict).toBe('unverified');
    expect(v.breaches).toEqual([]);
    expect(v.summary).toMatch(/unmeasured/i);
    expect(v.summary).toContain('1');
    // A FAIL the floor still cannot attribute keeps refusing: `pages` unmeasured AND another failed check it
    // has no rule for; or a measured (rendered) count below an exact budget, which IS a verdict.
    expect(draftFloorVerdict({ ...refusedWithoutRender, failed: ['pages', 'fonts'] }, EXACT_2).verdict).toBe('fail');
    // (codex r1) a malformed failed entry is as unattributable as an unknown one; a report with no
    // count, or a floor with no budget, establishes nothing and keeps the check's FAIL.
    expect(draftFloorVerdict({ ...refusedWithoutRender, failed: ['pages', {}] }, EXACT_2).verdict).toBe('fail');
    expect(draftFloorVerdict({ ...refusedWithoutRender, failed: ['pages', null] }, EXACT_2).verdict).toBe('fail');
    const noCount = { ...refusedWithoutRender, checks: { ...refusedWithoutRender.checks, pages: { verified: false } } };
    expect(draftFloorVerdict(noCount, EXACT_2).verdict).toBe('fail');
    expect(draftFloorVerdict(refusedWithoutRender, NO_BUDGET).verdict).toBe('fail');
    const renderedShort = draftFloorVerdict(
      { ...(report({ pages: 1, pagesVerified: true }) as object), verdict: 'FAIL', failed: ['pages'] },
      EXACT_2,
    );
    expect(renderedShort.verdict).toBe('fail');
    expect(renderedShort.breaches[0]).toContain('reports FAIL on pages');
  });

  it('every breach is reported together, not just the first', () => {
    const v = draftFloorVerdict(
      report({ claims: false, byKind: { 'cite-off': 9 }, contrast: false, pages: 4 }),
      EXACT_2,
    );
    expect(v.verdict).toBe('fail');
    expect(v.breaches).toHaveLength(3);
    expect(v.summary).toContain('3 breach(es)');
  });

  it('no page budget (a web page / prose doc) never produces a page breach', () => {
    expect(draftFloorVerdict(report({ pages: 9 }), NO_BUDGET).verdict).toBe('pass');
  });

  it('an answer that is not the report is UNAVAILABLE — never rounded to a pass (codex review)', () => {
    expect(draftFloorVerdict(null, EXACT_2).verdict).toBe('unavailable');
    expect(draftFloorVerdict('boom', EXACT_2).verdict).toBe('unavailable');
    // Red before the review fix: `{}` and a schema drift judged nothing and answered `pass`, so a
    // breaching draft landed on a self-check whose report the floor could not read.
    expect(draftFloorVerdict({}, EXACT_2).verdict).toBe('unavailable');
    expect(draftFloorVerdict({ checks: {} }, EXACT_2).verdict).toBe('unavailable');
    expect(draftFloorVerdict({ checks: { claims: { ok: true } } }, EXACT_2).verdict).toBe('unavailable');
    expect(draftFloorVerdict({ checks: { claims: { ok: 'yes' }, contrast: { ok: true } } }, EXACT_2).verdict).toBe(
      'unavailable',
    );
    const drifted = draftFloorVerdict({ ...(report() as object), verdict: 'FAIL', failed: ['claims'] }, EXACT_2);
    expect(drifted.verdict, 'a report that declares itself FAILED is never a pass').toBe('fail');
    expect(drifted.breaches[0]).toContain('reports FAIL on claims');
  });
});

describe('draftFloorArgv — the same inputs the worker clause names, minus --render', () => {
  it('names the launcher, the script, the budget, the snapshots and --json; never --render', () => {
    const argv = draftFloorArgv('/garden', '/out/doc.html', EXACT_2, ['/snap/a', '/snap/b']);
    expect(argv[0]).toBe(join('/garden', 'scripts', 'wicked-garden.mjs'));
    expect(argv.slice(1, 4)).toEqual(['run', DRAFT_SELF_CHECK_SCRIPT, '/out/doc.html']);
    expect(argv).toContain('--exact');
    expect(argv.join(' ')).toContain('--pages 2');
    expect(argv.join(' ')).toContain('--repo /snap/a --repo /snap/b');
    expect(argv).toContain('--json');
    expect(argv).not.toContain('--render');
  });

  it('a web page has no page budget and is judged on screen; no snapshot means no --repo', () => {
    const argv = draftFloorArgv('/garden', '/out/doc.html', NO_BUDGET, [], { style: 'web' });
    expect(argv).toContain('--no-pages');
    expect(argv.join(' ')).toContain('--mode screen --min-font-pt 0');
    expect(argv).not.toContain('--repo');
  });
});

describe('runDraftFloor — never throws, and a floor that cannot run says so', () => {
  it('no installed garden plugin root → unavailable, naming what could not be run', async () => {
    const v = await runDraftFloor('/out/doc.html', EXACT_2, [], {}, { gardenRoot: () => null });
    expect(v.verdict).toBe('unavailable');
    expect(v.summary).toContain(DRAFT_SELF_CHECK_SCRIPT);
  });

  it('a non-JSON answer (no Python behind the launcher) → unavailable with the exit code', async () => {
    const v = await runDraftFloor('/out/doc.html', EXACT_2, [], {}, {
      gardenRoot: () => '/garden',
      run: async () => ({ stdout: 'Traceback (most recent call last):', code: 1 }),
    });
    expect(v.verdict).toBe('unavailable');
    expect(v.summary).toContain('exited 1');
  });

  it('a spawn that throws → unavailable, never a rejection the seam has to catch', async () => {
    const v = await runDraftFloor('/out/doc.html', EXACT_2, [], {}, {
      gardenRoot: () => '/garden',
      run: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    expect(v.verdict).toBe('unavailable');
    expect(v.summary).toContain('spawn ENOENT');
  });

  it('runs the check on the saved file and answers its verdict', async () => {
    const seen: string[][] = [];
    const v = await runDraftFloor('/out/doc.html', EXACT_2, ['/snap'], { style: 'brochure' }, {
      gardenRoot: () => '/garden',
      run: async (argv) => {
        seen.push(argv);
        return { stdout: JSON.stringify(report({ claims: false, byKind: { placeholder: 1 } })), code: 1 };
      },
    });
    expect(v.verdict).toBe('fail');
    expect(v.breaches[0]).toContain('1 placeholder');
    expect(seen[0]?.join(' ')).toContain('--repo /snap');
  });
});
