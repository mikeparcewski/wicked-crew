/**
 * (crew#372, DES-372 rev 4) Product publish: a finished compose run's plan becomes GitHub issues in a repository linked
 * to the project, by a person, card first.
 *
 *   POST /projects/:id/product/publish          HUMAN (operator)  without `confirm`: the card and its `publishHash`,
 *                                                                  nothing sent; with `confirm` = that hash: the
 *                                                                  missing items are created, then read back; with
 *                                                                  `resolve`: a person settles one `unsure` item
 *   GET  /projects/:id/product/publish/:runId   HUMAN (operator)  whether the run can be published (and why not), the
 *                                                                  project's GitHub repositories, and every publication
 *                                                                  of the run, read back as `readBackOf` allows (crew#1911)
 *
 * The plan is read only from a run whose launch recorded compose facts ({@link ComposeFacts}) and whose draft and
 * review units still match them, or ran a plan a person edited at its gate (crew#1902, proven from the run view and
 * said on the card); any other change is refused, in plain words. The repository is the project's
 * own GitHub tracker ({@link projectGithubTracker}); the write is the tracker write path's (`vendorRead` as the person,
 * admission re-read before each call, the credential the card was read with pinned). Each item is journaled, flushed,
 * before and after it is sent (`<mcp state>/product-publish/<sha256(runId)>/<publication>.ndjson`), so a crash never
 * resends: an item whose outcome crew cannot prove is `unsure` until a person resolves it. "Published" is the journal
 * plus a read-back of every created issue, never the run's own claim.
 *
 * A publication is sent or resolved by one request at a time IN THIS DAEMON (the slot), as tracker actions are
 * (`actions.ts` inFlight) and settings writes (`adapter.ts` updateSettings): the state-home fence does not make one
 * daemon per home, and a second daemon on the same state home is not covered here either.
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from '../zod.js';

import { API_PREFIX } from './api-prefix.js';
import { appendLineSynced } from './audit.js';
import { trustAtLeast } from './auth.js';
import { type ComposeFacts, sha256Hex } from './compose-facts.js';
import type {
  Actor,
  ProductPublicationsResponse,
  ProductPublishCard,
  ProductPublishResponse,
  PublicationItemState,
  PublicationState,
  PublishItem,
  SessionView,
} from '../core/types.js';
import { canonicalJson } from '../mcp/classify.js';
import { configOf, pmDescriptorHash } from '../mcp/registry.js';
import { mcpStateDir, type McpRegistryStore } from '../mcp/registry-store.js';
import { bindingInForce, githubUrlIdentity, readPayload, vendorText } from '../knowledge/trackers/bindings.js';
import { liveTool, type PmGate, projectOptsVia } from '../knowledge/trackers/gate-pm.js';
import { type PmEntry, pmEntriesOf, projectGithubTargets, projectGithubTracker, type RepoSelector, parseRepoSelector, type TrackerSetEntry } from '../knowledge/trackers/set.js';

const V = API_PREFIX;

/** The most items (epics, features and stories) one publication creates. */
export const PUBLISH_ITEMS_MAX = 200;
/** What the GitHub projector keeps of a body (`PM_TEXT_MAX`): a body is budgeted whole against it. */
export const PUBLISH_BODY_MAX = 6_000;
/** A parent reference at its widest: `#` and ten digits. */
const PARENT_REF_MAX = '#9999999999';
const PARENT = '{{parent}}';

export interface ProductPublishDeps {
  store?: Pick<McpRegistryStore, 'read'>;
  pm?: Pick<PmGate, 'vendorRead'>;
  /** Whether the project exists (`false` = 404). */
  projectExists: (projectId: string) => Promise<boolean>;
  /** The compose facts a run's launch recorded (RunTimingIndex.composeOf). */
  composeOf: (runId: string) => ComposeFacts | undefined;
  runView: (runId: string) => Promise<SessionView | undefined>;
  /** A unit's captured output (`adapter.workOutput`), keyed `<run>:<step>`. */
  workOutput: (unitId: string) => Promise<string | null>;
  audit: { record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): unknown };
  actorOf: (req: FastifyRequest) => Actor;
  /** Where the journal lives (the fenced `mcp` directory by default). */
  journalDir?: string;
  /** The flushed append (a test seam for a failing barrier). */
  appendLine?: (path: string, line: string, mode?: number) => Promise<void>;
  /** The journal's directory syncs after its approval (a test seam for a failing barrier). */
  syncJournalDirs?: (path: string) => Promise<void>;
  now?: () => number;
}

// ── The plan ───────────────────────────────────────────────────────────────────────────────────────────

const Title = z.string().min(1).max(256);
const PlanSchema = z.strictObject({
  epics: z
    .array(
      z.strictObject({
        title: Title,
        features: z
          .array(
            z.strictObject({
              title: Title,
              requirementRefs: z.array(z.strictObject({ repoId: z.string().min(1).max(200), key: z.string().min(1).max(200) })).min(1),
              stories: z
                .array(
                  z.strictObject({
                    title: Title,
                    acceptance: z.array(z.string().min(1).max(1_000)).max(20),
                    tasks: z.array(z.strictObject({ title: Title })).max(30).optional(),
                  }),
                )
                .max(50)
                .optional(),
            }),
          )
          .max(50),
      }),
    )
    .min(1)
    .max(50),
});
type Plan = z.infer<typeof PlanSchema>;

type Refusal = { ok: false; status: number; code: string; error: string; extra?: Record<string, unknown> };
const refuse = (status: number, code: string, error: string, extra?: Record<string, unknown>): Refusal => ({ ok: false, status, code, error, ...(extra !== undefined ? { extra } : {}) });

/** The plain-words refusal of a run whose plan crew cannot take as the compose launched it (coord ruling, 2026-11-24). */
const EDITED = "this plan was changed in a way publishing doesn't support (a step's kind, its review or an amendment); compose again to publish";
/** (crew#1902, coord ruling Q1) A gate edit that carried a note: the engine appends the note to the step's description
 *  (` (operator amendment: …)`), never to its instructions, so it is refused in its own words (crew#1983). */
const EDITED_WITH_NOTE = "this plan was edited at its gate with a note; publishing an edited plan with a note isn't supported yet: edit it without a note, or compose again to publish";

/** wicked-core's `mint_proposal_id`: `"p-" + deterministic_key([run, by, source])` (team/events.rs), where
 *  `deterministic_key` is the first 16 bytes of sha256 over each part followed by a NUL, in hex (bus.rs). */
export function mintProposalId(runId: string, by: string, source: string): string {
  const h = createHash('sha256');
  for (const p of [runId, by, source]) {
    h.update(p, 'utf8');
    h.update(Buffer.from([0]));
  }
  return `p-${h.digest('hex').slice(0, 32)}`;
}

/** wicked-core's `INSTRUCTION_SEP` (plan.rs): a structured description is `<step> ||| <instructions>`. */
const INSTRUCTION_SEP = ' ||| ';

/** The most gates one run's counter is searched across (a run opens a handful). */
const GATE_SEQ_MAX = 1_000;

/**
 * (crew#1902) The plan revision a person's edit at the plan gate gave `u` (a draft or review step whose instructions are
 * not the ones Compose wrote), or why crew cannot confirm one. Proven from the run view the engine serves, never
 * assumed (wicked-core#1929: a person's edit at the gate amends the held steps it restates; the PA's and the members'
 * changes only add steps):
 *  - the unit says which accepted revision it last ran under (`plan_rev`, core#1925), and it is the run's accepted plan
 *    (an older revision is not on the view, so it is not confirmed);
 *  - that revision's proposal is a person's edit AT A GATE: its id is the one the engine mints for a gate edit
 *    (`mint_proposal_id(run, "human", Gate{gate_id})`, gate ids `g-<run>-<n>` for each gate the run opened). A plan a
 *    person changed through the mid-run edit route (`Edit{request_id}`) or a seat's plan never has that id;
 *  - that revision's step with the unit's id is the unit: the same catalog and the same instructions.
 * The note a gate edit may carry is checked on every step once any step is edited ({@link composedPlan}).
 */
function gateEditOf(view: SessionView, runId: string, id: string, u: SessionView['units'][number]): { ok: true; rev: number } | { ok: false; detail: string } {
  const session = view.session as unknown as { team_plan?: { accepted?: unknown } | null; team?: { gate_seq?: unknown } | null };
  const rev = (u as { plan_rev?: unknown }).plan_rev;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) return { ok: false, detail: `the engine did not record which plan revision the ${id} step ran under` };
  const accepted = session.team_plan?.accepted;
  const a = typeof accepted === 'object' && accepted !== null ? (accepted as Record<string, unknown>) : null;
  if (a === null || a['rev'] !== rev) return { ok: false, detail: `the ${id} step ran under plan revision ${rev}, which is not the run's accepted plan` };
  const seq = session.team?.gate_seq;
  const pid = a['proposal_id'];
  const gates = typeof seq === 'number' && Number.isInteger(seq) && seq > 0 ? Math.min(seq, GATE_SEQ_MAX) : 0;
  let atGate = false;
  for (let n = 1; n <= gates && !atGate; n++) atGate = typeof pid === 'string' && pid === mintProposalId(runId, 'human', `g-${runId}-${n}`);
  if (!atGate) return { ok: false, detail: `plan revision ${rev} was not a person's edit at the plan's gate` };
  if (!acceptedStepIs(view, id, u)) return { ok: false, detail: `the ${id} step is not the one plan revision ${rev} accepted` };
  return { ok: true, rev };
}

/** Whether the run's accepted plan has a step `id` with `u`'s catalog and instructions (sha256). */
function acceptedStepIs(view: SessionView, id: string, u: SessionView['units'][number]): boolean {
  const accepted = (view.session as unknown as { team_plan?: { accepted?: unknown } | null }).team_plan?.accepted;
  const steps = typeof accepted === 'object' && accepted !== null ? ((accepted as Record<string, unknown>)['steps'] as { steps?: unknown } | null | undefined)?.steps : undefined;
  const step = Array.isArray(steps) ? (steps as unknown[]).find((x) => typeof x === 'object' && x !== null && (x as Record<string, unknown>)['id'] === id) as Record<string, unknown> | undefined : undefined;
  return step !== undefined && step['catalog'] === u.catalog && typeof step['instructions'] === 'string' && sha256Hex(step['instructions']) === sha256Hex(u.instructions ?? '');
}

/** Whether a structured description is exactly `<step> ||| <instructions>`: the engine splits it at the FIRST separator
 *  (wicked-core plan.rs `INSTRUCTION_SEP`, `split_once`), and a gate's note is appended after the instructions. */
function noNoteOn(u: SessionView['units'][number]): boolean {
  const at = typeof u.description === 'string' ? u.description.indexOf(INSTRUCTION_SEP) : -1;
  return at >= 0 && u.description.slice(at + INSTRUCTION_SEP.length) === u.instructions;
}

/** The last fenced ```json block of a draft's output, or `null`. */
export function lastJsonBlock(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(/^[ \t]*```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gm)) last = m[1]!;
  return last;
}

const oneLine = (s: string): string => s.replace(/\s+/gu, ' ').trim();
/** Text as the projector keeps it (line endings, control characters), whole. */
const normal = (s: string): string => vendorText(s, Number.POSITIVE_INFINITY) ?? '';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const isSelector = (cp: number): boolean => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * The first character github-mcp-server would take out of `s` before crew reads it back, or `null`. Its
 * `sanitize.FilterInvisibleCharacters` (pkg/sanitize/sanitize.go, applied to titles by `sanitize.PlainText` and to
 * bodies by `sanitize.Content`, pkg/github/minimal_types.go) removes U+200B, U+200C, U+200E, U+200F, U+061C, U+00AD,
 * U+FEFF, U+180E, U+2060..U+2064, U+202A..U+202E, U+2066..U+2069, U+E0001 and U+E0020..U+E007F (all Unicode category
 * Cf; crew refuses the whole category), and a variation selector (U+FE00..U+FE0F, U+E0100..U+E01EF) unless it follows
 * a graphic, non-space base that is not itself a selector: a Han base for U+E0100 and up, and only `#`, `*` or a digit
 * with U+FE0E or U+FE0F for an ASCII base. Invalid UTF-16 (a lone surrogate) would become U+FFFD.
 */
export function strippedCharacter(s: string): string | null {
  const cf = /\p{Cf}/u.exec(s);
  if (cf !== null) return hex(cf[0].codePointAt(0)!);
  const lone = LONE_SURROGATE.exec(s);
  if (lone !== null) return hex(lone[0].charCodeAt(0));
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]!.codePointAt(0)!;
    if (!isSelector(cp)) continue;
    const prev = i > 0 ? chars[i - 1]! : null;
    const pcp = prev === null ? -1 : prev.codePointAt(0)!;
    const base = prev !== null && !isSelector(pcp) && /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(prev);
    const kept = base && (cp >= 0xe0100 ? /^\p{Script=Han}$/u.test(prev!) : pcp < 0x80 ? /^[#*0-9]$/.test(prev!) && (cp === 0xfe0e || cp === 0xfe0f) : true);
    if (!kept) return hex(cp);
  }
  return null;
}

/**
 * Why a title would not read back as written, or `null`. Besides {@link strippedCharacter}, the server's
 * `sanitize.PlainText` drops HTML tags and code-fence info from a title, decodes character references, and escapes
 * `&`, `<` and `>` (crew reads those back decoded).
 */
function titleRefusal(t: string): string | null {
  const c = strippedCharacter(t);
  if (c !== null) return `has an invisible character (${c}) that GitHub's server removes`;
  if (/<[A-Za-z/!?]/.test(t)) return 'has text GitHub reads as an HTML tag (a "<" before a letter)';
  // PlainText decodes an entity before it escapes the text again, so `&lt;` (or `&#60`, `&amp`) would come back as
  // another character. Every entity name has at least two characters, so `Q&A` and `R&D` stay as written.
  if (/&(#|[A-Za-z]{2})/.test(t)) return 'has "&" right before "#" or a word, which GitHub reads as an HTML character reference';
  // The projector keeps 400 characters of the title as the server answers it, escaped.
  if (t.replace(/&/g, '&amp;').replace(/[<>]/g, '&lt;').length > 400) return 'is too long once GitHub escapes its "&", "<" and ">"';
  if (/^\s*```/.test(t)) return 'starts with a code fence';
  if (t.includes(PARENT)) return `has the text ${PARENT}, which crew uses for the parent issue`;
  return null;
}

/** The footer every body ends with: a visible line and a marker naming the run and the item. */
export function publishFooter(runId: string, key: string): string {
  return `\n\n---\nPublished by wicked-crew from run ${runId}\n<!-- wicked-publish run=${runId} key=${key} -->`;
}

/** The card's items from a plan, or the first item that cannot be published as written. */
export function publishItems(runId: string, plan: Plan, facts: ComposeFacts): { ok: true; items: PublishItem[] } | { ok: false; error: string } {
  const selected = new Set(facts.requirements.map((r) => `${r.repoId}\u0000${r.key}`));
  const covered = new Set<string>();
  const items: PublishItem[] = [];
  const title = (key: string, raw: string): string | { error: string } => {
    const t = oneLine(normal(raw));
    if (t === '') return { error: `${key} has an empty title` };
    const why = titleRefusal(t);
    return why === null ? t : { error: `the title of ${key} ${why}` };
  };
  const text = (key: string, raw: string): string | { error: string } => {
    const t = oneLine(normal(raw));
    const c = strippedCharacter(t);
    if (c !== null) return { error: `${key} has an invisible character (${c}) that GitHub's server removes` };
    if (t.includes(PARENT)) return { error: `${key} has the text ${PARENT}, which crew uses for the parent issue` };
    return t;
  };
  const push = (key: string, kind: PublishItem['kind'], t: string, lines: string[], parentKey: string | null): string | null => {
    const body = `${lines.join('\n')}${parentKey !== null ? `\n\nPart of ${PARENT}` : ''}${publishFooter(runId, key)}`;
    if (body.split(PARENT).join(PARENT_REF_MAX).length > PUBLISH_BODY_MAX) return `${kind} ${key} is too long to publish`;
    items.push({ key, kind, title: t, body, parentKey });
    return null;
  };
  for (const [ei, epic] of plan.epics.entries()) {
    const ek = `e${ei + 1}`;
    const et = title(ek, epic.title);
    if (typeof et !== 'string') return { ok: false, ...et };
    const ftitles: string[] = [];
    for (const [fi, f] of epic.features.entries()) {
      const ft = title(`${ek}.f${fi + 1}`, f.title);
      if (typeof ft !== 'string') return { ok: false, ...ft };
      ftitles.push(ft);
    }
    const eerr = push(ek, 'epic', et, ftitles.length === 0 ? ['This epic has no features yet.'] : ['Features:', ...ftitles.map((t) => `- ${t}`)], null);
    if (eerr !== null) return { ok: false, error: eerr };
    for (const [fi, f] of epic.features.entries()) {
      const fk = `${ek}.f${fi + 1}`;
      for (const r of f.requirementRefs) {
        const id = `${r.repoId}\u0000${r.key}`;
        if (!selected.has(id)) return { ok: false, error: `${fk} names requirement ${r.repoId} ${r.key}, which this compose was not given` };
        covered.add(id);
      }
      if (facts.level === 'epics' && (f.stories ?? []).length > 0) return { ok: false, error: `${fk} has stories, but this compose drafted epics and features only` };
      const refLines: string[] = [];
      for (const r of f.requirementRefs) {
        const t = text(`${fk} (requirement ${r.repoId} ${r.key})`, `${r.repoId} ${r.key}`);
        if (typeof t !== 'string') return { ok: false, ...t };
        refLines.push(`- ${t}`);
      }
      const ferr = push(fk, 'feature', ftitles[fi]!, ['Requirements:', ...refLines], ek);
      if (ferr !== null) return { ok: false, error: ferr };
      for (const [si, s] of (f.stories ?? []).entries()) {
        const sk = `${fk}.s${si + 1}`;
        if (facts.level !== 'tasks' && (s.tasks ?? []).length > 0) return { ok: false, error: `${sk} has tasks, but this compose drafted ${facts.level} only` };
        const st = title(sk, s.title);
        if (typeof st !== 'string') return { ok: false, ...st };
        const lines: string[] = ['Acceptance criteria:'];
        if (s.acceptance.length === 0) lines.push('- [ ] (none given)');
        for (const a of s.acceptance) {
          const t = text(sk, a);
          if (typeof t !== 'string') return { ok: false, ...t };
          lines.push(`- [ ] ${t}`);
        }
        if ((s.tasks ?? []).length > 0) {
          lines.push('', 'Tasks:');
          for (const [ti, task] of (s.tasks ?? []).entries()) {
            const tt = title(`${sk} task ${ti + 1}`, task.title);
            if (typeof tt !== 'string') return { ok: false, ...tt };
            lines.push(`- [ ] ${tt}`);
          }
        }
        const serr = push(sk, 'story', st, lines, fk);
        if (serr !== null) return { ok: false, error: serr };
      }
    }
  }
  for (const r of facts.requirements) if (!covered.has(`${r.repoId}\u0000${r.key}`)) return { ok: false, error: `no feature covers requirement ${r.repoId} ${r.key}, which this compose was given` };
  if (items.length > PUBLISH_ITEMS_MAX) return { ok: false, error: `the plan has ${items.length} items; at most ${PUBLISH_ITEMS_MAX} are published at once` };
  return { ok: true, items };
}

/** The ordered publication content, each body a template (`{{parent}}` for the parent's issue). */
export function contentShaOf(items: readonly PublishItem[]): string {
  return sha256Hex(canonicalJson(items.map((i) => ({ key: i.key, kind: i.kind, title: i.title, body: i.body, parentKey: i.parentKey }))));
}

/** One run published to one repository, whatever connector reaches it. */
export function publicationOf(runId: string, repo: string): string {
  return sha256Hex(`${runId}\u0000${repo.toLowerCase()}`);
}

const sameGate = (g: unknown): boolean => typeof g === 'object' && g !== null && canonicalJson(g) === canonicalJson({ human_confirm: { unconditional: true } });

/**
 * The run's plan as the compose launched it, or why not. Its draft and review units must be the steps the compose
 * recorded (same catalog, same instructions, no amendments), the review the evaluator behind an unconditional human
 * gate; the engine's own units around them (scope, test plan, design) are its to add. (crew#1902) A step whose
 * instructions a person changed at the plan's gate is taken as edited when {@link gateEditOf} proves it; `edited`
 * names the revision.
 */
export async function composedPlan(deps: Pick<ProductPublishDeps, 'composeOf' | 'runView' | 'workOutput'>, projectId: string, runId: string): Promise<{ ok: true; facts: ComposeFacts; items: PublishItem[]; edited: { planRev: number } | null } | Refusal> {
  const view = await deps.runView(runId);
  if (view === undefined) return refuse(404, 'run_not_found', `no run ${runId}`);
  const facts = deps.composeOf(runId);
  if (facts === undefined || facts.projectId !== projectId) {
    return refuse(409, 'not_a_compose', "this run was not composed for this project, or it was composed before publishing was added; compose again to publish");
  }
  // A run still working has no units to judge yet (they appear once its scope is planned): say it is not finished.
  if (view.session.status !== 'completed') return refuse(409, 'run_not_finished', `this compose has not finished (it is ${view.session.status}); publish it once its review is confirmed`);
  const unverified = (detail: string, edited = false): Refusal =>
    refuse(409, 'compose_unverified', edited ? EDITED : `crew cannot confirm this is the compose as it was launched (${detail}); compose again to publish`, { detail });
  const draft = view.units.filter((u) => u.id === `${runId}:draft`);
  const review = view.units.filter((u) => u.id === `${runId}:review`);
  if (draft.length !== 1 || review.length !== 1) return unverified('the run does not have exactly one draft step and one review step');
  const d = draft[0]!;
  const r = review[0]!;
  if (d.ord > r.ord) return unverified('the review step runs before the draft step');
  // (crew#1902) The plan revision a person's gate edit gave the steps, when one did; else the launch's own steps.
  let edited: number | null = null;
  for (const [u, id] of [[d, 'draft'], [r, 'review']] as const) {
    const step = facts.steps.find((s) => s.id === id);
    if (step === undefined || u.catalog !== step.catalog) return unverified(`the ${id} step is not the ${step?.catalog ?? id} step Compose launched`, true);
    if (u.structured_description !== true || typeof u.instructions !== 'string') return unverified(`the engine did not record the ${id} step's instructions`);
    if (sha256Hex(u.instructions) !== step.instructionsSha) {
      const g = gateEditOf(view, runId, id, u);
      if (!g.ok) return refuse(409, 'compose_unverified', `crew cannot confirm this plan's change was a person's edit at its gate (${g.detail}); compose again to publish`, { detail: g.detail });
      edited = Math.max(edited ?? 0, g.rev);
    }
    if ((u.amendments ?? []).length > 0) return unverified(`the ${id} step was amended`, true);
  }
  // (crew#1902, coord Q1) A gate edit's note lands on the description of the step the plan releases next (` (operator
  // amendment: …)`), which need not be the step the person edited (codex on #1988: an edit of the review alone put its
  // note on the unchanged draft). So once any step is a gate edit, NEITHER step may carry text after its instructions.
  // The published plan is the accepted revision as a whole (agy on #1988): a step left as launched must still be that
  // revision's step too, so a revision that changed a step which had already run never stands behind the card.
  if (edited !== null) {
    for (const [u, id] of [[d, 'draft'], [r, 'review']] as const) {
      if (!acceptedStepIs(view, id, u)) {
        const detail = `the ${id} step is not the one plan revision ${edited} accepted`;
        return refuse(409, 'compose_unverified', `crew cannot confirm this plan's change was a person's edit at its gate (${detail}); compose again to publish`, { detail });
      }
      // The note comes after `<step> ||| <instructions>` (codex r2, agy: an exact split, never a suffix match).
      if (!noNoteOn(u)) return refuse(409, 'compose_unverified', EDITED_WITH_NOTE, { detail: `the ${id} step carries a note from its gate` });
    }
  }
  if (r.role !== 'evaluator' || !sameGate(r.gate)) return unverified("the review step is not the evaluator behind a person's confirmation", true);
  if (d.status !== 'done' || r.status !== 'done') return unverified('the draft or its review did not finish');
  const out = await deps.workOutput(`${runId}:draft`);
  if (out === null || out.trim() === '') return refuse(409, 'plan_unreadable', 'the draft step left no output to publish');
  const block = lastJsonBlock(out);
  if (block === null) return refuse(409, 'plan_unreadable', 'the draft does not end with a ```json plan block');
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return refuse(409, 'plan_unreadable', "the draft's plan block is not valid JSON");
  }
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`).join('; ');
    return refuse(409, 'plan_unreadable', `the draft's plan is not the shape Compose asks for (${why})`);
  }
  const items = publishItems(runId, parsed.data, facts);
  if (!items.ok) return refuse(409, 'plan_unreadable', items.error);
  return { ok: true, facts, items: items.items, edited: edited === null ? null : { planRev: edited } };
}

// ── The journal ────────────────────────────────────────────────────────────────────────────────────────

const ItemSchema = z.strictObject({ key: z.string().min(1).max(40), kind: z.enum(['epic', 'feature', 'story']), title: z.string(), body: z.string(), parentKey: z.string().nullable() });
const CardSchema = z.strictObject({ runId: z.string(), projectId: z.string(), repo: z.string(), source: z.string(), identity: z.string(), items: z.array(ItemSchema).min(1).max(PUBLISH_ITEMS_MAX), edited: z.strictObject({ planRev: z.number().int().positive() }).optional() });
const Envelope = { v: z.literal(1), publication: z.string(), runId: z.string(), projectId: z.string(), repo: z.string(), at: z.string(), by: z.string() };
const LineSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...Envelope, kind: z.literal('approved'), publishHash: z.string(), contentSha: z.string(), card: CardSchema, sourceId: z.string(), trackerId: z.string(), descriptor: z.string(), principal: z.string() }),
  z.strictObject({ ...Envelope, kind: z.literal('sending'), key: z.string() }),
  z.strictObject({ ...Envelope, kind: z.literal('created'), key: z.string(), number: z.number().int().positive(), url: z.string() }),
  z.strictObject({ ...Envelope, kind: z.literal('not_sent'), key: z.string(), reason: z.string() }),
  z.strictObject({ ...Envelope, kind: z.literal('unsure'), key: z.string(), why: z.string() }),
  z.strictObject({ ...Envelope, kind: z.literal('resolved'), key: z.string(), number: z.number().int().positive().nullable(), url: z.string().nullable() }),
]);
type Line = z.infer<typeof LineSchema>;
type Approved = Extract<Line, { kind: 'approved' }>;

interface ItemFold {
  state: 'created' | 'sending' | 'not_sent' | 'unsure' | 'absent';
  number: number | null;
  url: string | null;
  why: string | null;
}

/** A publication's journal, folded: the first approval (its content is frozen), the latest one, each item's last state. */
export interface Folded {
  first: Approved | null;
  last: Approved | null;
  items: Map<string, ItemFold>;
}

class JournalUnreadable extends Error {}

/** Where a publication's journal is. */
function journalPath(dir: string, runId: string, publication: string): string {
  return join(dir, 'product-publish', sha256Hex(runId), `${publication}.ndjson`);
}

/**
 * Fold one journal. A dangling `sending` (no outcome after it) is `unsure` unless `live` (this daemon is sending it
 * now, read just after the journal). A line cut short by a crash mid-append (it does not end its object: its barrier never returned, so nothing was
 * sent on it, and every line's absence leaves an item no further along) is skipped; any other line crew cannot read
 * throws {@link JournalUnreadable}: a damaged journal is never read as empty.
 */
async function fold(path: string, publication: string, live: () => boolean): Promise<Folded> {
  let text: string;
  let sendingNow = false;
  try {
    text = await readFile(path, 'utf8');
    // Read after the journal: a send that started meanwhile shows `sending`, not a stop.
    sendingNow = live();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { first: null, last: null, items: new Map() };
    throw new JournalUnreadable(`the publish journal could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  const out: Folded = { first: null, last: null, items: new Map() };
  const lines = text.split('\n');
  for (const [i, raw] of lines.entries()) {
    const l = raw.trim();
    if (l === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      if (!l.endsWith('}')) continue; // torn by a crash mid-append (doc)
      throw new JournalUnreadable(`line ${i + 1} of the publish journal does not parse`);
    }
    const p = LineSchema.safeParse(v);
    if (!p.success || p.data.publication !== publication) throw new JournalUnreadable(`line ${i + 1} of the publish journal is not one crew wrote for this publication`);
    const line = p.data;
    if (line.kind === 'approved') {
      if (out.first === null) out.first = line;
      out.last = line;
      continue;
    }
    if (out.first === null || !out.first.card.items.some((x) => x.key === line.key)) throw new JournalUnreadable(`line ${i + 1} of the publish journal names an item no approval lists`);
    const s: ItemFold =
      line.kind === 'sending' ? { state: 'sending', number: null, url: null, why: null }
      : line.kind === 'created' ? { state: 'created', number: line.number, url: line.url, why: null }
      : line.kind === 'not_sent' ? { state: 'not_sent', number: null, url: null, why: line.reason }
      : line.kind === 'unsure' ? { state: 'unsure', number: null, url: null, why: line.why }
      : line.number === null ? { state: 'absent', number: null, url: null, why: null }
      : { state: 'created', number: line.number, url: line.url, why: null };
    out.items.set(line.key, s);
  }
  if (!sendingNow) {
    for (const [k, s] of out.items) {
      if (s.state === 'sending') out.items.set(k, { state: 'unsure', number: null, url: null, why: 'crew stopped after sending it and before it could record the answer' });
    }
  }
  return out;
}

// ── Read-back ──────────────────────────────────────────────────────────────────────────────────────────

/** The server's title escaping, read back (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&#34;`, `&#x27;`), once. */
const decodeTitle = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|#39|#34|#x27);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#34': '"', '#x27': "'" })[e] ?? `&${e};`);

/** A body with its parent reference resolved. */
const bodyWith = (body: string, parent: number | null): string => (parent === null ? body : body.split(PARENT).join(`#${parent}`));

type Read = { ok: true; title: string; body: string; url: string } | { ok: false };

/** Read one issue of the tracker through its bound read and projector (the reading an agent gets). */
async function readIssue(pm: Pick<PmGate, 'vendorRead'>, e: PmEntry, t: TrackerSetEntry, number: number): Promise<Read> {
  const stored = e.record.tools.find((x) => x.name === 'issue_read' && x.present);
  const binding = stored === undefined ? null : bindingInForce('github', stored);
  if (binding === null) return { ok: false };
  const [owner, repo] = t.key.split('/');
  const prepared = binding.bindArgs({ method: 'get', owner, repo, issue_number: number }, [{ trackerId: t.trackerId, tenant: t.tenant, key: t.key, siteHost: t.siteHost }]);
  if (!prepared.ok) return { ok: false };
  const r = await pm.vendorRead(e, 'issue_read', prepared.args, 'person');
  if (!r.ok) return { ok: false };
  const p = binding.project(r.result, prepared, await projectOptsVia(pm, e, r.credential));
  const v = p.ok && p.items.length === 1 ? p.items[0]!.value : null;
  if (v === null || typeof v['title'] !== 'string' || typeof v['url'] !== 'string') return { ok: false };
  return { ok: true, title: decodeTitle(v['title']), body: typeof v['body'] === 'string' ? v['body'] : '', url: v['url'] };
}

/** fsync a directory (where the platform can open one). */
async function syncDir(d: string): Promise<void> {
  let fh;
  try {
    fh = await open(d, 'r');
  } catch (err) {
    if (process.platform === 'win32') return;
    throw err;
  }
  try {
    await fh.sync();
  } catch (err) {
    if (process.platform !== 'win32') throw err;
  } finally {
    await fh.close();
  }
}

/**
 * Make a journal durable where it lives: its directory (the file's entry), the run's directory and `product-publish/`
 * (their entries), every call, so a retry or a concurrent caller never relies on a sync another one made. Strict: a
 * failure stops the send.
 */
async function syncChain(path: string): Promise<void> {
  for (let d = dirname(path), i = 0; i < 3; d = dirname(d), i++) await syncDir(d);
}

// ── The routes ─────────────────────────────────────────────────────────────────────────────────────────

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export const ProductPublishSchema = z
  .strictObject({
    runId: z.string().regex(RUN_ID, 'a run id'),
    repo: z.string().min(3).max(250),
    confirm: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    resolve: z
      .strictObject({
        key: z.string().regex(/^e[1-9][0-9]{0,2}(\.f[1-9][0-9]{0,2}(\.s[1-9][0-9]{0,2})?)?$/, 'an item key (e1, e1.f2, e1.f2.s3)'),
        issue: z.number().int().min(1).max(9_999_999_999).nullable(),
      })
      .optional(),
  })
  .refine((b) => b.confirm === undefined || b.resolve === undefined, { error: 'confirm and resolve are separate requests' });

/**
 * Codes `vendorRead` answers before anything is sent, from crew's own state: the only outcomes that prove an issue was
 * not created. (`changed` too, but only when publish's own admission refused it: see `revoked`.)
 */
const NOT_SENT = new Set(['source_off', 'busy', 'rate_limited', 'remote_work_pending', 'secret_missing', 'credential_changed', 'gh_not_installed', 'gh_signed_out', 'gh_token_unavailable']);

/** How long an issue read back as matching is trusted before it is read again (crew#1911). */
export const READ_BACK_FRESH_MS = 60_000;

/** Who asks for a read-back: the holder of a publication's slot, or anyone else (crew#1911). */
type Reads = 'owner' | 'observer';

export function registerProductPublishRoutes(app: FastifyInstance, deps: ProductPublishDeps): void {
  /** Publications being sent or resolved now, taken before the first await (DES Send step 1). */
  const slots = new Set<string>();
  /**
   * (crew#1911) The last read-back of each created issue, by publication and item key, for the number and content it
   * was read against. Who reads GitHub:
   * - the slot owner (a send or resolve) reads each issue without a fresh `ok` read-back, the send right after each
   *   create, in turn with its creates;
   * - an observer (a GET, a card, a refusal outside the slot) reads one only while no publication is being sent or
   *   resolved in this daemon, and a new slot waits for observer reads already running to finish. While a slot is held an
   *   observer answers the last read-back, or `null` (not checked yet) for an issue not read yet (crew#1919).
   * So a panel's polling never queues reads beside a create on the source's scheduler (knowledge/gate/scheduler.ts
   * refuses a full queue `busy`), for this publication or another on the same source.
   */
  const readBacks = new Map<string, { number: number; expect: string; readBack: 'ok' | 'differs' | 'unreadable'; url: string | null; at: number }>();
  // Monotonic (crew#1919): a wall clock stepped back never keeps a read-back fresh. `now` is the tests' clock.
  const clock = (): number => (deps.now !== undefined ? deps.now() : performance.now());
  /** Observer reads running now, and the slots waiting for them to finish. */
  let observing = 0;
  const drained: Array<() => void> = [];
  const dir = (): string => deps.journalDir ?? mcpStateDir();
  const nowIso = (): string => new Date((deps.now ?? Date.now)()).toISOString();
  const humanOnly = (actor: Actor) => ({
    error: actor.kind === 'human' ? `publishing to a tracker needs operator trust; you are ${actor.trust}` : `only a person publishes to a tracker; you are ${actor.kind}/${actor.trust}`,
    code: 'publish_human_only',
  });
  const allowed = (actor: Actor): boolean => actor.kind === 'human' && trustAtLeast(actor, 'operator');
  const send = (reply: FastifyReply, r: Refusal) => reply.code(r.status).send({ error: r.error, code: r.code, ...(r.extra ?? {}) });

  async function entries(): Promise<PmEntry[] | Refusal> {
    if (deps.store === undefined || deps.pm === undefined) return refuse(503, 'registry_unavailable', 'this daemon has no tracker registry');
    try {
      return pmEntriesOf(await deps.store.read());
    } catch {
      return refuse(503, 'registry_unavailable', 'the tracker registry could not be read now');
    }
  }

  /** One created issue read back against what was sent, or the last read-back of it when that is trusted for `reads`. */
  async function readBackOf(publication: string, reader: { e: PmEntry; t: TrackerSetEntry } | null, it: PublishItem, number: number, parent: number | null, reads: Reads): Promise<{ readBack: 'ok' | 'differs' | 'unreadable' | null; url: string | null }> {
    const expectBody = normal(bodyWith(it.body, parent));
    const expect = sha256Hex(`${it.title}\u0000${expectBody}`);
    const key = `${publication}\u0000${it.key}`;
    const memo = readBacks.get(key);
    const known = memo !== undefined && memo.number === number && memo.expect === expect ? memo : undefined;
    if (known !== undefined && known.readBack === 'ok' && clock() - known.at < READ_BACK_FRESH_MS) return { readBack: 'ok', url: known.url };
    // Checked before every read, not once per answer: a slot taken meanwhile stops this observer's next read.
    // One not read yet is not checked yet (null), never `unreadable`, which reads as deleted (crew#1919).
    if (reads === 'observer' && slots.size > 0) return known !== undefined ? { readBack: known.readBack, url: known.url } : { readBack: null, url: null };
    let read: Read;
    if (reader === null) read = { ok: false };
    else if (reads === 'owner') read = await readIssue(deps.pm!, reader.e, reader.t, number);
    else {
      observing++;
      try {
        read = await readIssue(deps.pm!, reader.e, reader.t, number);
      } finally {
        if (--observing === 0) for (const w of drained.splice(0)) w();
      }
    }
    const readBack = !read.ok ? 'unreadable' : read.title === it.title && read.body === expectBody ? 'ok' : 'differs';
    const url = read.ok ? read.url : null;
    readBacks.set(key, { number, expect, readBack, url, at: clock() });
    return { readBack, url };
  }

  /** A publication's state now: its journal, each created issue read back as {@link readBackOf} allows `reads`. */
  async function stateOf(f: Folded, projectId: string, sel: RepoSelector, es: PmEntry[] | null, reads: Reads): Promise<PublicationState> {
    const approved = f.last!;
    const card = f.first!.card;
    let reader: { e: PmEntry; t: TrackerSetEntry } | null = null;
    if (es !== null) {
      const adm = projectGithubTracker(es, projectId, { source: approved.card.source, repo: sel.repo });
      if (adm.ok && adm.e.id === approved.sourceId) reader = { e: adm.e, t: adm.t };
    }
    const numbers = new Map<string, number>();
    for (const [k, s] of f.items) if (s.state === 'created' && s.number !== null) numbers.set(k, s.number);
    const items: PublicationItemState[] = [];
    for (const it of card.items) {
      const s = f.items.get(it.key);
      const state: PublicationItemState['state'] = s?.state ?? 'missing';
      let readBack: PublicationItemState['readBack'] = null;
      let url = s?.url ?? null;
      if (state === 'created' && s!.number !== null) {
        const parent = it.parentKey === null ? null : (numbers.get(it.parentKey) ?? null);
        const got = await readBackOf(f.first!.publication, reader, it, s!.number, parent, reads);
        readBack = got.readBack;
        if (got.url !== null) url = got.url;
      }
      items.push({ key: it.key, kind: it.kind, title: it.title, state, number: s?.number ?? null, url, readBack, ...(s?.why != null ? { why: s.why } : {}) });
    }
    return { repo: card.repo, source: approved.card.source, publishHash: approved.publishHash, items, published: items.every((i) => i.state === 'created' && i.readBack === 'ok') };
  }

  type Built = { card: ProductPublishCard; publishHash: string; contentSha: string; e: PmEntry; t: TrackerSetEntry; descriptor: string; principal: string; credential: string; es: PmEntry[]; f: Folded; publication: string; path: string };

  /** The card for `sel` built NOW (DES "The card"), or why there is none. */
  async function build(projectId: string, runId: string, sel: RepoSelector, holding: boolean): Promise<{ ok: true; b: Built } | Refusal> {
    if (!(await deps.projectExists(projectId))) return refuse(404, 'project_not_found', `no project ${projectId}`);
    const plan = await composedPlan(deps, projectId, runId);
    if (!plan.ok) return plan;
    const es = await entries();
    if (!Array.isArray(es)) return es;
    const adm = projectGithubTracker(es, projectId, sel);
    if (!adm.ok) return refuse(adm.code === 'ambiguous' ? 409 : 404, adm.code, adm.error);
    const { e, t } = adm;
    if (!liveTool(e.record.tools.find((x) => x.name === 'issue_write' && x.present))) {
      return refuse(409, 'write_tool_off', `${e.name} has no saved, switched-on issue_write tool: a person grants it on the source's sheet`);
    }
    const publication = publicationOf(runId, t.key);
    const path = journalPath(dir(), runId, publication);
    let f: Folded;
    try {
      f = await fold(path, publication, holding ? () => false : () => slots.has(publication));
    } catch (err) {
      if (err instanceof JournalUnreadable) return refuse(409, 'journal_unreadable', `${err.message}; nothing is sent until it is repaired`);
      throw err;
    }
    const contentSha = contentShaOf(plan.items);
    if (f.first !== null && f.first.contentSha !== contentSha) {
      return refuse(409, 'publication_differs', `this run was already published to ${t.key} with other content; nothing more is sent to it`, { publication: await stateOf(f, projectId, sel, es, holding ? 'owner' : 'observer') });
    }
    const who = await deps.pm!.vendorRead(e, 'get_me', {}, 'person');
    const me = who.ok ? readPayload(who.result, e.name, 'github') : null;
    const m = me !== null && me.ok && typeof me.payload === 'object' && me.payload !== null ? (me.payload as Record<string, unknown>) : null;
    const identity = m !== null && typeof m['login'] === 'string' && m['login'] !== '' ? m['login'] : null;
    if (identity === null || !who.ok) return refuse(503, 'source_unavailable', `${e.name} could not say which account it posts as now, so no card is offered`);
    if (who.credential === null) return refuse(409, 'credential_unpinned', `${e.name} has no credential of its own to pin, so crew cannot be sure which account would post; give the source its own credential`);
    const principal = String(m!['id'] ?? identity);
    // (crew#1902) An edited plan says so on the card, and so in the hash a person confirms. An unedited card is the same
    // object as before (no key), so its hash does not move.
    const card: ProductPublishCard = { runId, projectId, repo: t.key.toLowerCase(), source: e.name, identity, items: plan.items, ...(plan.edited !== null ? { edited: plan.edited } : {}) };
    const descriptor = pmDescriptorHash(configOf(e.record));
    const publishHash = sha256Hex(canonicalJson({ v: 1, card, contentSha, sourceId: e.id, trackerId: t.trackerId, descriptor, principal, credential: who.credential }));
    return { ok: true, b: { card, publishHash, contentSha, e, t, descriptor, principal, credential: who.credential, es, f, publication, path } };
  }

  const envelope = (b: { publication: string; runId: string; projectId: string; repo: string }, actor: Actor) => ({ v: 1 as const, publication: b.publication, runId: b.runId, projectId: b.projectId, repo: b.repo, at: nowIso(), by: actor.id });
  const write = async (path: string, line: Record<string, unknown>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await (deps.appendLine ?? appendLineSynced)(path, `${JSON.stringify(line)}\n`, 0o600);
  };

  async function confirm(projectId: string, runId: string, sel: RepoSelector, hash: string, actor: Actor, log: FastifyRequest['log']): Promise<{ ok: true; body: ProductPublishResponse } | Refusal> {
    const built = await build(projectId, runId, sel, true);
    if (!built.ok) return built;
    const b = built.b;
    if ([...b.f.items.values()].some((s) => s.state === 'unsure')) {
      return refuse(409, 'unresolved', 'an earlier publish could not tell whether some issues were created; say for each whether it exists (resolve) before publishing again', { publication: await stateOf(b.f, projectId, sel, b.es, 'owner') });
    }
    if (hash !== b.publishHash) {
      return refuse(409, 'card_changed', 'the card changed since it was shown (the plan, the account, the source or the link); nothing was sent: look at it again', { card: b.card, publishHash: b.publishHash });
    }
    const env = { publication: b.publication, runId, projectId, repo: b.card.repo };
    try {
      await write(b.path, { ...envelope(env, actor), kind: 'approved', publishHash: b.publishHash, contentSha: b.contentSha, card: b.card, sourceId: b.e.id, trackerId: b.t.trackerId, descriptor: b.descriptor, principal: b.principal });
      await (deps.syncJournalDirs ?? syncChain)(b.path);
    } catch (err) {
      log.warn(`[publish] the approval for ${runId} could not be recorded: ${err instanceof Error ? err.message : String(err)}`);
      return refuse(503, 'journal_unavailable', 'crew could not record the approval, so nothing was sent');
    }
    /** Whether THIS item's admission was refused here (a `changed` answer proves nothing was sent only then). */
    let revoked = false;
    /** Immediately before each create, with the source's slot taken: still this project's tracker, unchanged, writable. */
    const admittedFor = async (): Promise<PmEntry | null> => {
      const e = await admission();
      if (e === null) revoked = true;
      return e;
    };
    const admission = async (): Promise<PmEntry | null> => {
      try {
        const es = pmEntriesOf(await deps.store!.read());
        const adm = projectGithubTracker(es, projectId, sel);
        if (!adm.ok || adm.e.id !== b.e.id || adm.t.trackerId !== b.t.trackerId || !adm.e.enabled) return null;
        if (pmDescriptorHash(configOf(adm.e.record)) !== b.descriptor) return null;
        if (!liveTool(adm.e.record.tools.find((x) => x.name === 'issue_write' && x.present))) return null;
        return adm.e;
      } catch {
        return null;
      }
    };
    const numbers = new Map<string, number>();
    for (const [k, s] of b.f.items) if (s.state === 'created' && s.number !== null) numbers.set(k, s.number);
    const tally = { created: 0, refused: 0, unsure: 0 };
    const [owner, repo] = b.t.key.split('/');
    for (const it of b.card.items) {
      if (numbers.has(it.key)) continue;
      const parent = it.parentKey === null ? null : (numbers.get(it.parentKey) ?? null);
      if (it.parentKey !== null && parent === null) break;
      try {
        await write(b.path, { ...envelope(env, actor), kind: 'sending', key: it.key });
      } catch (err) {
        log.warn(`[publish] the send of ${it.key} could not be recorded, so it was not sent: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      revoked = false;
      const r = await deps.pm!.vendorRead(b.e, 'issue_write', { method: 'create', owner, repo, title: it.title, body: bodyWith(it.body, parent) }, 'person', admittedFor, b.credential);
      let outcome: Record<string, unknown>;
      // `changed` is a refusal before dispatch only when this admission said so: never read from the vendor's words.
      if (!r.ok && (r.code === 'changed' ? revoked : NOT_SENT.has(r.code))) {
        outcome = { kind: 'not_sent', key: it.key, reason: r.reason };
        tally.refused++;
      } else {
        const a = r.ok ? readPayload(r.result, b.e.name, 'github') : null;
        const p = a !== null && a.ok && typeof a.payload === 'object' && a.payload !== null ? (a.payload as Record<string, unknown>) : null;
        const url = p === null ? null : p['url'];
        const id = githubUrlIdentity(url);
        if (id !== null && /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[1-9][0-9]{0,9}$/.test(String(url)) && id.repo === b.t.key.toLowerCase()) {
          outcome = { kind: 'created', key: it.key, number: id.number, url };
          numbers.set(it.key, id.number);
          tally.created++;
        } else {
          const why = !r.ok
            ? `${r.reason}; GitHub may have created it`
            : a !== null && !a.ok && a.code === 'vendor_error'
              ? `GitHub answered an error, which it also does after it created an issue (${a.reason})`
              : 'GitHub answered in a shape crew could not read as this repository\'s new issue';
          outcome = { kind: 'unsure', key: it.key, why };
          tally.unsure++;
        }
      }
      try {
        await write(b.path, { ...envelope(env, actor), ...outcome });
      } catch (err) {
        log.warn(`[publish] the outcome of ${it.key} could not be recorded; sending stops: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      if (outcome['kind'] !== 'created') break;
      // (crew#1911) Read it back now, inside the slot and in turn with the creates, so no GET has to.
      await readBackOf(b.publication, { e: b.e, t: b.t }, it, outcome['number'] as number, parent, 'owner');
    }
    let f: Folded;
    try {
      f = await fold(b.path, b.publication, () => false);
    } catch (err) {
      if (err instanceof JournalUnreadable) return refuse(409, 'journal_unreadable', `${err.message}; nothing more is sent until it is repaired`);
      throw err;
    }
    const publication = await stateOf(f, projectId, sel, b.es, 'owner');
    deps.audit.record('product.publish', actor, { runId, detail: { projectId, repo: b.card.repo, source: b.e.name, identity: b.card.identity, ...tally, published: publication.published } });
    return { ok: true, body: { done: true, card: b.card, publication } };
  }

  async function resolve(projectId: string, runId: string, sel: RepoSelector, want: { key: string; issue: number | null }, actor: Actor): Promise<{ ok: true; body: ProductPublishResponse } | Refusal> {
    if (!(await deps.projectExists(projectId))) return refuse(404, 'project_not_found', `no project ${projectId}`);
    const es = await entries();
    if (!Array.isArray(es)) return es;
    const publication = publicationOf(runId, sel.repo);
    const path = journalPath(dir(), runId, publication);
    let f: Folded;
    try {
      f = await fold(path, publication, () => false);
    } catch (err) {
      if (err instanceof JournalUnreadable) return refuse(409, 'journal_unreadable', `${err.message}; nothing is changed until it is repaired`);
      throw err;
    }
    if (f.first === null || f.first.projectId !== projectId) return refuse(409, 'not_unsure', `this run has no publication to ${sel.repo} in this project`);
    const s = f.items.get(want.key);
    const it = f.first.card.items.find((x) => x.key === want.key);
    if (it === undefined || s === undefined || s.state !== 'unsure') return refuse(409, 'not_unsure', `${want.key} is not waiting to be resolved (it is ${s?.state ?? (it === undefined ? 'not an item of this publication' : 'missing')})`);
    const env = { publication, runId, projectId, repo: f.first.card.repo };
    let line: Record<string, unknown>;
    if (want.issue === null) {
      line = { ...envelope(env, actor), kind: 'resolved', key: it.key, number: null, url: null };
    } else {
      const adm = projectGithubTracker(es, projectId, { source: f.last!.card.source, repo: sel.repo });
      if (!adm.ok || adm.e.id !== f.last!.sourceId) return refuse(adm.ok ? 404 : adm.code === 'ambiguous' ? 409 : 404, adm.ok ? 'repo_not_linked' : adm.code, adm.ok ? `${sel.repo} is no longer reached through ${f.last!.card.source}` : adm.error);
      const read = await readIssue(deps.pm!, adm.e, adm.t, want.issue);
      if (!read.ok) return refuse(503, 'source_unavailable', `${adm.e.name} could not read #${want.issue} now`);
      const numbers = new Map<string, number>();
      for (const [k, x] of f.items) if (x.state === 'created' && x.number !== null) numbers.set(k, x.number);
      const parent = it.parentKey === null ? null : (numbers.get(it.parentKey) ?? null);
      if (read.title !== it.title || read.body !== normal(bodyWith(it.body, parent))) {
        return refuse(409, 'resolve_differs', `#${want.issue} is not ${it.key}: its title or body is not what was approved for it`);
      }
      line = { ...envelope(env, actor), kind: 'resolved', key: it.key, number: want.issue, url: read.url };
    }
    try {
      await write(path, line);
    } catch {
      return refuse(503, 'journal_unavailable', 'crew could not record the answer; nothing changed');
    }
    deps.audit.record('product.publish.resolve', actor, { runId, detail: { projectId, repo: f.first.card.repo, key: it.key, issue: want.issue } });
    const after = await fold(path, publication, () => false);
    const { edited, ...kept } = after.last!.card;
    return { ok: true, body: { done: true, card: edited === undefined ? kept : { ...kept, edited }, publication: await stateOf(after, projectId, sel, es, 'owner') } };
  }

  app.post<{ Params: { id: string } }>(
    `${V}/projects/:id/product/publish`,
    { config: { manifest: { requestType: 'ProductPublishBody', responseType: 'ProductPublishResponse', statusCodes: [200, 400, 403, 404, 409, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (!allowed(actor)) return reply.code(403).send(humanOnly(actor));
      const parsed = ProductPublishSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), code: 'bad_request' });
      const sel = parseRepoSelector(parsed.data.repo);
      if (sel === null) return reply.code(400).send({ error: 'repo: owner/repo, or <source>:owner/repo', code: 'bad_request' });
      const { runId, confirm: hash, resolve: want } = parsed.data;
      const projectId = req.params.id;
      if (hash === undefined && want === undefined) {
        // (crew#1911) A card asks GitHub which account posts (`get_me`): an observer read, so none while anything is
        // being sent or resolved here, and a slot taken meanwhile waits for it.
        if (slots.size > 0) return reply.code(409).send({ error: 'a publish is being sent or resolved right now; ask for the card again in a moment', code: 'in_progress' });
        observing++;
        try {
          const built = await build(projectId, runId, sel, false);
          if (!built.ok) return send(reply, built);
          const b = built.b;
          const answer: ProductPublishResponse = { done: false, card: b.card, publishHash: b.publishHash, publication: b.f.first === null ? null : await stateOf(b.f, projectId, sel, b.es, 'observer') };
          return answer;
        } finally {
          if (--observing === 0) for (const w of drained.splice(0)) w();
        }
      }
      // Taken synchronously, before any await: a second send or resolve of this publication is refused here.
      const slot = publicationOf(runId, sel.repo);
      if (slots.has(slot)) return reply.code(409).send({ error: 'this publication is being sent or resolved right now; look again in a moment', code: 'in_progress' });
      slots.add(slot);
      let out: { ok: true; body: ProductPublishResponse } | Refusal;
      // Released BEFORE the answer is sent: a client that acts on the answer at once finds the publication free.
      try {
        // (crew#1911) No observer read starts once a slot is held; wait for any already on the source's queue.
        while (observing > 0) await new Promise<void>((r) => drained.push(r));
        out = want !== undefined ? await resolve(projectId, runId, sel, want, actor) : await confirm(projectId, runId, sel, hash!, actor, req.log);
      } finally {
        slots.delete(slot);
      }
      if (!out.ok) return send(reply, out);
      return out.body;
    },
  );

  app.get<{ Params: { id: string; runId: string } }>(
    `${V}/projects/:id/product/publish/:runId`,
    { config: { manifest: { responseType: 'ProductPublicationsResponse', statusCodes: [200, 400, 403, 404, 409, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (!allowed(actor)) return reply.code(403).send(humanOnly(actor));
      const { id: projectId, runId } = req.params;
      if (!RUN_ID.test(runId)) return reply.code(400).send({ error: 'runId: a run id', code: 'bad_request' });
      if (!(await deps.projectExists(projectId))) return reply.code(404).send({ error: `no project ${projectId}`, code: 'project_not_found' });
      const plan = await composedPlan(deps, projectId, runId);
      if (!plan.ok && plan.code === 'run_not_found') return send(reply, plan);
      const es = await entries();
      if (!Array.isArray(es)) return send(reply, es);
      const list = es;
      const runDir = join(dir(), 'product-publish', sha256Hex(runId));
      let files: string[] = [];
      try {
        files = (await readdir(runDir)).filter((n) => /^[0-9a-f]{64}\.ndjson$/.test(n)).sort();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return reply.code(503).send({ error: 'the publish journal could not be read now', code: 'journal_unavailable' });
      }
      const publications: PublicationState[] = [];
      for (const n of files) {
        const publication = n.slice(0, 64);
        let f: Folded;
        try {
          f = await fold(join(runDir, n), publication, () => slots.has(publication));
        } catch (err) {
          if (err instanceof JournalUnreadable) return reply.code(409).send({ error: `${err.message}; nothing is sent until it is repaired`, code: 'journal_unreadable' });
          throw err;
        }
        if (f.first === null || f.first.projectId !== projectId || f.first.runId !== runId) continue;
        publications.push(await stateOf(f, projectId, { source: null, repo: f.first.card.repo }, list, 'observer'));
      }
      const answer: ProductPublicationsResponse = {
        runId,
        publishable: plan.ok ? { ok: true, items: plan.items.length } : { ok: false, code: plan.code, error: plan.error },
        targets: projectGithubTargets(list, projectId),
        publications,
      };
      return answer;
    },
  );
}
