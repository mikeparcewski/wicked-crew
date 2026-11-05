/**
 * Governed actions on a run's issues (DES-PM-001 §5, §6 step 4; DES-KNOWLEDGE-DATA-001 §11): a comment, a
 * transition, or both on one card, at the deliver gate ("Comment on PROJA-123 and move it to In Review?"). In v1
 * every action ASKS: nothing here runs unasked, and no agent reaches it.
 *
 *   GET  /runs/:id/tracker-actions   HUMAN   the issues the run addresses, each with the link that still admits it
 *   POST /runs/:id/tracker-actions   HUMAN   without `confirm`: the card and its `actionHash`, nothing sent;
 *                                            with `confirm` = that hash: exactly that, as the registered identity
 *
 * The issue must be in the run's tracker set NOW (its project's links and its repos', under the source's switches),
 * read from the registry and the engine's memberships on each call; an issue outside it has no card (404
 * `issue_not_in_tracker_set`). The card names what would be posted, as whom, from and to which state (mapped to
 * todo/doing/done), and the link that admits the issue. A confirm is judged against a card rebuilt NOW: a card that
 * changed (another identity, the state moved, the link removed) is 409 `card_changed` and nothing is sent.
 * Recorded against the run (`<state home>/mcp/tracker-actions.ndjson`) and audited `knowledge.tracker.action`.
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { API_PREFIX } from '../../api/api-prefix.js';
import { trustAtLeast } from '../../api/auth.js';
import type { Actor, RunTrackerIssuesResponse, TrackerActionCard, TrackerActionResponse } from '../../core/types.js';
import { canonicalJson } from '../../mcp/classify.js';
import { configOf, pmDescriptorHash } from '../../mcp/registry.js';
import { mcpStateDir, type McpRegistryStore } from '../../mcp/registry-store.js';
import { bindingInForce } from './bindings.js';
import type { TrackerAddresses } from './addresses.js';
import { type PmGate, projectOptsVia } from './gate-pm.js';
import { candidatesFor, githubRef, jiraRefs, type PmRef } from './issues.js';
import { jiraCategory, readPayload } from './bindings.js';
import { linkedSetOf, type PmEntry, pmEntriesOf, type TrackerSetEntry, trackerSetOf, unitRepos } from './set.js';

const V = API_PREFIX;
export const ACTION_COMMENT_MAX = 8_000;

export interface TrackerActionDeps {
  store?: Pick<McpRegistryStore, 'read'>;
  pm?: Pick<PmGate, 'vendorRead' | 'personOp'>;
  addresses?: Pick<TrackerAddresses, 'of'>;
  /** The run's project and repo, as the engine recorded them; `null` = no such run. */
  runScope: (runId: string) => Promise<{ projectId: string | null; repoId: string | null } | null>;
  members?: (projectId: string) => Promise<string[]>;
  audit: { record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): unknown };
  actorOf: (req: FastifyRequest) => Actor;
  /** Where the action record goes (the fenced `mcp` directory by default). */
  recordDir?: string;
  now?: () => number;
}

export const TrackerActionSchema = z
  .object({
    issue: z.string().min(2).max(300),
    comment: z.string().min(1).max(ACTION_COMMENT_MAX).optional(),
    transition: z.string().min(1).max(120).optional(),
    confirm: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .refine((b) => b.comment !== undefined || b.transition !== undefined, { message: 'name a comment, a transition, or both' });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex');
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The single JSON payload of a person read, or `null` (the rule the projectors use). */
function payload(result: Record<string, unknown>): unknown {
  const r = readPayload(result);
  return r.ok ? r.payload : null;
}

/** A reference as a card takes it: `PROJA-1`, `<source>:PROJA-1`, `owner/repo#42`, `#42`. */
export function parseActionIssue(raw: string, jiraKeys: ReadonlySet<string>): PmRef | null {
  const t = raw.trim();
  const j = jiraRefs(t, jiraKeys);
  if (j.length === 1 && j[0]!.ref === t) return j[0]!;
  return githubRef(t);
}

/** The run's tracker set and the one tracker an issue reference names in it, or why there is none. */
async function admit(
  deps: TrackerActionDeps,
  runId: string,
  issue: string,
): Promise<{ ok: true; entries: PmEntry[]; set: TrackerSetEntry[]; t: TrackerSetEntry; e: PmEntry; ref: PmRef; scope: { projectId: string | null; repoId: string | null } } | { ok: false; status: number; code: string; error: string }> {
  const scope = await deps.runScope(runId);
  if (scope === null) return { ok: false, status: 404, code: 'run_not_found', error: `no run ${runId}` };
  const entries = pmEntriesOf(await deps.store!.read());
  const jiraKeys = new Set(entries.filter((e) => e.system === 'jira').flatMap((e) => e.trackers.map((t) => t.key)));
  const ref = parseActionIssue(issue, jiraKeys);
  if (ref === null) return { ok: false, status: 404, code: 'issue_not_in_tracker_set', error: `${issue} is not an issue of this run's trackers` };
  const set = trackerSetOf(entries, scope.projectId, await unitRepos(scope, deps.members));
  const cands = candidatesFor(ref, set, scope.repoId);
  if (cands.length === 0) return { ok: false, status: 404, code: 'issue_not_in_tracker_set', error: `${issue} is not in this run's tracker set (its project's links and its repositories'), so it has no card` };
  if (cands.length > 1) return { ok: false, status: 409, code: 'ambiguous', error: ref.system === 'jira' ? `${cands.length} linked trackers have ${issue}: name it as <source>:${issue} or <source>@<site>:${issue}` : `${cands.length} GitHub sources link this repository: a person unlinks it from all but one` };
  const t = cands[0]!;
  const e = entries.find((x) => x.id === t.sourceId)!;
  return { ok: true, entries, set, t, e, ref, scope };
}

/** The vendor-side issue key a card names (`PROJA-1`, `owner/repo#42`). */
function issueKey(ref: PmRef, t: TrackerSetEntry): string {
  return ref.system === 'jira' ? `${ref.key}-${ref.number}` : `${t.key}#${ref.number}`;
}

/** Whether a stored tool can be called by the person now (saved, its schema the one last seen). */
function registered(e: PmEntry, tool: string): boolean {
  const t = e.record.tools.find((x) => x.name === tool && x.present);
  // A write tool a person left off at registration (G1: writes register disabled until granted) is not called.
  return t !== undefined && t.enabled && t.schemaHash !== null && t.schemaHash === t.observedSchemaHash;
}

type Plan = { card: TrackerActionCard; hash: string; transitionId: string | null; credential: string | null };

/** Build the card from the tracker NOW (module doc). */
async function plan(deps: TrackerActionDeps, runId: string, body: z.infer<typeof TrackerActionSchema>): Promise<{ ok: true; plan: Plan; a: Extract<Awaited<ReturnType<typeof admit>>, { ok: true }> } | { ok: false; status: number; code: string; error: string }> {
  const a = await admit(deps, runId, body.issue);
  if (!a.ok) return a;
  const pm = deps.pm!;
  const { e, t, ref } = a;
  const key = issueKey(ref, t);
  const linked = linkedSetOf(a.set, e.id);
  // The issue's title and state, through the bound read and its projector (the same reading an agent gets).
  const readTool = e.system === 'jira' ? 'getJiraIssue' : 'issue_read';
  const stored = e.record.tools.find((x) => x.name === readTool && x.present);
  const binding = stored === undefined ? null : bindingInForce(e.system, stored);
  let title: string | null = null;
  let state: string | null = null;
  let category: 'todo' | 'doing' | 'done' | null = null;
  if (binding !== null) {
    const [owner, repo] = t.key.split('/');
    const prepared = binding.bindArgs(ref.system === 'jira' ? { cloudId: t.tenant, issueIdOrKey: key } : { method: 'get', owner, repo, issue_number: ref.number }, linked);
    if (prepared.ok) {
      const r = await pm.vendorRead(e, readTool, prepared.args, 'person');
      const p = r.ok ? binding.project(r.result, prepared, await projectOptsVia(pm, e, r.credential)) : null;
      const v = p !== null && p.ok && p.items.length === 1 ? p.items[0]!.value : null;
      if (v !== null) {
        title = String((e.system === 'jira' ? v['summary'] : v['title']) ?? '') || null;
        state = typeof (e.system === 'jira' ? v['status'] : v['state']) === 'string' ? String(e.system === 'jira' ? v['status'] : v['state']) : null;
        category = e.system === 'jira' ? ((v['statusCategory'] as 'todo' | 'doing' | 'done' | null) ?? null) : state === 'closed' ? 'done' : state === 'open' ? 'todo' : null;
      }
    }
  }
  // Who the tracker will say did it.
  const who = await pm.vendorRead(e, e.system === 'jira' ? 'atlassianUserInfo' : 'get_me', {}, 'person');
  const me = who.ok ? payload(who.result) : null;
  // GitHub `get_me`: {login}; Atlassian v2 `atlassianUserInfo`: {accountId} (the older shape: {account_id, name}).
  const identity = isObj(me) ? String(me['login'] ?? me['name'] ?? me['displayName'] ?? me['nickname'] ?? me['account_id'] ?? me['accountId'] ?? '') || null : null;
  const principal = isObj(me) ? String(me['account_id'] ?? me['accountId'] ?? me['id'] ?? me['login'] ?? '') || null : null;
  // The credential the posting account was read with: the write is sent only with the same one.
  const credential = who.ok ? who.credential : null;
  // A card is offered only when crew could read what it acts on and as whom: nothing is approved blind.
  if (title === null || identity === null || principal === null) {
    return { ok: false, status: 503, code: 'source_unavailable', error: `${e.name} could not be read now (the issue, or the account it posts as), so no card is offered` };
  }
  let transition: TrackerActionCard['transition'];
  let transitionId: string | null = null;
  if (body.transition !== undefined) {
    if (e.system === 'github') {
      const to = body.transition.toLowerCase();
      if (to !== 'closed' && to !== 'open') return { ok: false, status: 409, code: 'transition_unavailable', error: 'a GitHub issue moves to closed or open' };
      transition = { from: state, to, mapped: { from: category, to: to === 'closed' ? 'done' : 'todo' } };
      transitionId = to;
    } else {
      const r = await pm.personOp(e, 'listJiraIssueTransitions', t.tenant, { issueIdOrKey: key });
      const p = r.ok ? payload(r.result) : null;
      const list = isObj(p) && Array.isArray(p['transitions']) ? (p['transitions'] as unknown[]).filter(isObj) : null;
      if (list === null) return { ok: false, status: 503, code: 'source_unavailable', error: `${e.name} could not list ${key}'s transitions now` };
      const want = body.transition.toLowerCase();
      const hit = list.find((x) => (isObj(x['to']) && String(x['to']['name'] ?? '').toLowerCase() === want) || String(x['name'] ?? '').toLowerCase() === want);
      if (hit === undefined) {
        const names = list.map((x) => (isObj(x['to']) ? String(x['to']['name'] ?? '') : String(x['name'] ?? ''))).filter((n) => n !== '');
        return { ok: false, status: 409, code: 'transition_unavailable', error: `${key} cannot move to ${body.transition} now; it can move to ${names.join(', ') || 'nothing'}` };
      }
      const to = isObj(hit['to']) ? hit['to'] : {};
      transition = { from: state, to: String(to['name'] ?? hit['name'] ?? body.transition), mapped: { from: category, to: jiraCategory(to['statusCategory']) } };
      transitionId = String(hit['id'] ?? '');
      if (transitionId === '') return { ok: false, status: 503, code: 'source_unavailable', error: `${e.name} answered a transition with no id` };
    }
  }
  const via = t.via.find((v) => v.kind === 'project') ?? t.via[0]!;
  const card: TrackerActionCard = {
    runId,
    source: e.name,
    system: e.system,
    tenant: t.tenant,
    ...(t.tenantLabel !== null ? { tenantLabel: t.tenantLabel } : {}),
    issue: key,
    title,
    identity,
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
    ...(transition !== undefined ? { transition } : {}),
    admittedBy: via.kind === 'project' ? { kind: 'project', id: a.scope.projectId ?? '' } : { kind: 'repo', id: via.id },
  };
  // Bound to what would act: the card, the tracker, the source's execution descriptor and the vendor principal.
  const hash = sha({ v: 1, card, sourceId: e.id, trackerId: t.trackerId, transitionId, descriptor: pmDescriptorHash(configOf(e.record)), principal, credential });
  return { ok: true, plan: { card, hash, transitionId, credential }, a };
}

async function act(deps: TrackerActionDeps, runId: string, issue: string, p: Plan, a: Extract<Awaited<ReturnType<typeof admit>>, { ok: true }>): Promise<TrackerActionResponse & { done: true }> {
  const pm = deps.pm!;
  const { e, t, ref } = a;
  /**
   * Run with the source's slot taken, immediately before a write is sent: the issue is still admitted by the same
   * tracker of the same, unchanged source, and its write tool is still saved and switched on. Sent with that entry.
   */
  const admittedFor = (tool: string) => async (): Promise<PmEntry | null> => {
    const again = await admit(deps, runId, issue).catch(() => null);
    if (again === null || !again.ok || again.t.trackerId !== t.trackerId) return null;
    if (pmDescriptorHash(configOf(again.e.record)) !== pmDescriptorHash(configOf(e.record)) || !registered(again.e, tool)) return null;
    return again.e;
  };
  const key = issueKey(ref, t);
  const [owner, repo] = t.key.split('/');
  const results: Array<{ part: 'comment' | 'transition'; ok: boolean; error?: string }> = [];
  const send = async (part: 'comment' | 'transition', tool: string, args: Record<string, unknown>): Promise<void> => {
    if (!registered(e, tool)) {
      results.push({ part, ok: false, error: `${e.name} has no saved, switched-on ${tool} tool: a person grants it on the source's sheet` });
      return;
    }
    const r = await pm.vendorRead(e, tool, args, 'person', admittedFor(tool), p.credential ?? undefined);
    // Done only on an answer crew can read as one: an error answered as data (the Atlassian server's `{error: true,
    // statusCode}`, often without `isError`) is a refusal, and an answer crew cannot read leaves the outcome unknown;
    // either way, nothing after it is sent.
    const answered = r.ok ? readPayload(r.result, e.name) : null;
    if (!r.ok) results.push({ part, ok: false, error: r.reason });
    else if (answered !== null && answered.ok) results.push({ part, ok: true });
    else if (answered !== null && answered.code === 'vendor_error') results.push({ part, ok: false, error: `the tracker refused the ${part} (${answered.reason})` });
    else results.push({ part, ok: false, error: `the tracker's answer to the ${part} could not be read, so crew cannot say whether it landed: check the issue` });
  };
  if (p.card.comment !== undefined) {
    await send('comment', e.system === 'jira' ? 'addOrEditJiraIssueComment' : 'add_issue_comment', e.system === 'jira' ? { cloudId: t.tenant, issueIdOrKey: key, commentBody: p.card.comment } : { owner, repo, issue_number: ref.number, body: p.card.comment });
  }
  if (p.card.transition !== undefined && results.every((x) => x.ok)) {
    await send('transition', e.system === 'jira' ? 'transitionJiraIssue' : 'issue_write', e.system === 'jira' ? { cloudId: t.tenant, issueIdOrKey: key, transition: { id: p.transitionId } } : { method: 'update', owner, repo, issue_number: ref.number, state: p.transitionId });
  }
  return { done: true, card: p.card, at: new Date((deps.now ?? Date.now)()).toISOString(), results };
}

export function registerTrackerActionRoutes(app: FastifyInstance, deps: TrackerActionDeps): void {
  const humanOnly = (actor: Actor) => ({
    error: actor.kind === 'human' ? `approving an action on a tracker needs operator trust; you are ${actor.trust}` : `only a person approves an action on a tracker; you are ${actor.kind}/${actor.trust}`,
    code: 'tracker_actions_human_only',
  });
  /** Confirmations already spent (10 minutes): a double submission sends nothing twice. */
  const spent = new Map<string, { at: number; done: TrackerActionResponse }>();
  /** Confirmations being acted on now: taken before the first await, so two at once cannot both send. */
  const inFlight = new Set<string>();
  const ready = (): boolean => deps.store !== undefined && deps.pm !== undefined;

  app.get<{ Params: { id: string } }>(
    `${V}/runs/:id/tracker-actions`,
    { config: { manifest: { responseType: 'RunTrackerIssuesResponse', statusCodes: [200, 403, 404, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (actor.kind !== 'human') return reply.code(403).send(humanOnly(actor));
      if (!ready() || deps.addresses === undefined) return reply.code(503).send({ error: 'this daemon has no tracker registry', code: 'registry_unavailable' });
      const scope = await deps.runScope(req.params.id);
      if (scope === null) return reply.code(404).send({ error: `no run ${req.params.id}`, code: 'run_not_found' });
      const entries = pmEntriesOf(await deps.store!.read());
      const set = trackerSetOf(entries, scope.projectId, await unitRepos(scope, deps.members));
      const body: RunTrackerIssuesResponse = {
        runId: req.params.id,
        issues: (await deps.addresses.of(req.params.id)).map((x) => {
          const t = set.find((s) => s.trackerId === x.trackerId);
          const via = t === undefined ? null : (t.via.find((v) => v.kind === 'project') ?? t.via[0] ?? null);
          const shared = t !== undefined && t.system === 'jira' && set.filter((y) => y.system === 'jira' && y.key === t.key).length > 1;
          return {
            issue: x.ref,
            // The reference POST takes for it: qualified when two trackers of this run's set share the key.
            ref: shared && t !== undefined ? `${t.source}@${t.tenant}:${x.ref}` : x.ref,
            source: x.source,
            system: x.system,
            trackerId: x.trackerId,
            admittedBy: via === null ? null : via.kind === 'project' ? { kind: 'project' as const, id: scope.projectId ?? '' } : { kind: 'repo' as const, id: via.id },
          };
        }),
      };
      return body;
    },
  );

  app.post<{ Params: { id: string } }>(
    `${V}/runs/:id/tracker-actions`,
    { config: { manifest: { requestType: 'TrackerActionBody', responseType: 'TrackerActionResponse', statusCodes: [200, 400, 403, 404, 409, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      if (!(actor.kind === 'human' && trustAtLeast(actor, 'operator'))) return reply.code(403).send(humanOnly(actor));
      const parsed = TrackerActionSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), code: 'bad_request' });
      if (!ready()) return reply.code(503).send({ error: 'this daemon has no tracker registry', code: 'registry_unavailable' });
      const confirm = parsed.data.confirm;
      const nowMs = (deps.now ?? Date.now)();
      for (const [h, v] of spent) if (nowMs - v.at > 10 * 60_000) spent.delete(h);
      if (confirm !== undefined) {
        // Reserved synchronously, before any await: a second request with the same confirmation is refused here.
        if (inFlight.has(confirm) || spent.has(confirm)) return reply.code(409).send({ error: 'this card was already confirmed; nothing was sent again', code: 'already_done', ...(spent.has(confirm) ? { done: spent.get(confirm)!.done } : {}) });
        inFlight.add(confirm);
      }
      try {
        return await confirmOrCard(req, reply, parsed.data, actor);
      } finally {
        if (confirm !== undefined) inFlight.delete(confirm);
      }
    },
  );

  async function confirmOrCard(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, body: z.infer<typeof TrackerActionSchema>, actor: Actor): Promise<unknown> {
      const parsed = { data: body };
      const planned = await plan(deps, req.params.id, parsed.data);
      if (!planned.ok) return reply.code(planned.status).send({ error: planned.error, code: planned.code });
      if (parsed.data.confirm === undefined) {
        const answer: TrackerActionResponse = { done: false, card: planned.plan.card, actionHash: planned.plan.hash };
        return answer;
      }
      const now = (deps.now ?? Date.now)();
      for (const [h, v] of spent) if (now - v.at > 10 * 60_000) spent.delete(h);
      if (parsed.data.confirm !== planned.plan.hash) {
        return reply.code(409).send({ error: 'the card changed since it was shown (the issue, its state, the identity or the link); nothing was sent: look at it again', code: 'card_changed', card: planned.plan.card, actionHash: planned.plan.hash });
      }
      spent.set(planned.plan.hash, { at: now, done: { done: false, card: planned.plan.card, actionHash: planned.plan.hash } });
      // The approved card is recorded BEFORE anything is sent; a record that cannot be written sends nothing.
      const dir = deps.recordDir ?? mcpStateDir();
      const record = async (line: Record<string, unknown>): Promise<void> => {
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, 'tracker-actions.ndjson'), `${JSON.stringify({ runId: req.params.id, by: actor.id, actionHash: planned.plan.hash, ...line })}\n`, { mode: 0o600 });
      };
      try {
        await record({ at: new Date(now).toISOString(), state: 'approved', card: planned.plan.card });
      } catch (err) {
        spent.delete(planned.plan.hash);
        req.log.warn(`[trackers] the action record for ${req.params.id} could not be written: ${message(err)}`);
        return reply.code(503).send({ error: 'crew could not record the approval, so nothing was sent', code: 'record_unavailable' });
      }
      const done = await act(deps, req.params.id, parsed.data.issue, planned.plan, planned.a);
      spent.set(planned.plan.hash, { at: now, done });
      const detail = { source: done.card.source, system: done.card.system, issue: done.card.issue, parts: done.results, identity: done.card.identity, admittedBy: done.card.admittedBy };
      deps.audit.record('knowledge.tracker.action', actor, { runId: req.params.id, detail });
      await record({ at: done.at, state: 'done', parts: done.results }).catch((err: unknown) => req.log.warn(`[trackers] the outcome record for ${req.params.id} could not be written: ${message(err)}`));
      return done;
  }
}
