/**
 * The decision ledger AT REST (DES-decision-capture §4.2.1, DC-S4a).
 *
 * One append-only JSONL file per project at `<state home>/decisions/<projectId|_unscoped>.jsonl`:
 * the directory 0700, each file 0600 — the posture of the chat transcripts (`chat-transcripts.ts`).
 * The words live HERE and nowhere else crew writes (never the bus, logs or `/diagnostics`).
 * Registered in `tests/fixtures/state-home-subtrees.json` as `decisions` (crew half) — the core half,
 * the worker Read fence, shipped with wicked-core-ts 0.7.35 — so a worker cannot read the operator's
 * words through the file system.
 *
 * Reads fold `record` + `outcome` lines into a {@link DecisionView}; the in-memory index is built
 * once at first use and kept current by `append`.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { crewStateHome } from '../projects/state-home.js';
import type { DecisionLine, DecisionOutcome, DecisionRecord, DecisionView } from './types.js';

/** The state-home entry (`<state home>/decisions/`) — the name the fixture registers. */
export const DECISIONS_DIRNAME = 'decisions';
const UNSCOPED = '_unscoped';
/** A project id admitted as a file name — anything else is filed under a hashed-safe spelling. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function defaultDecisionsDir(): string {
  return join(crewStateHome(), 'decisions');
}

export interface DecisionFilter {
  project?: string;
  chat?: string;
  run?: string;
  state?: DecisionView['state'];
  since?: number;
}

interface Folded {
  record: DecisionRecord;
  outcomes: DecisionOutcome[];
}

export class DecisionLedger {
  private readonly dir: string;
  private loaded = false;
  private readonly byId = new Map<string, Folded>();
  /** decision key → ids, in record order (recurrence + widen). */
  private readonly byKey = new Map<string, string[]>();
  /** estate proposal id → decision id (B12: answering either one resolves both). */
  private readonly byProposal = new Map<string, string>();

  constructor(dir: string = defaultDecisionsDir()) {
    this.dir = dir;
  }

  private fileFor(projectId: string | null): string {
    const name = projectId === null ? UNSCOPED : SAFE_NAME.test(projectId) ? projectId : `p_${Buffer.from(projectId).toString('hex').slice(0, 120)}`;
    return join(this.dir, `${name}.jsonl`);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.dir)) return;
    for (const entry of readdirSync(this.dir).sort()) {
      if (!entry.endsWith('.jsonl')) continue;
      const file = join(this.dir, entry);
      const text = readFileSync(file, 'utf8');
      // A torn last line (a crash mid-append) is terminated, so the next append starts a fresh
      // line instead of being glued onto it and lost on the next load (codex on DC-S4a).
      if (text !== '' && !text.endsWith('\n')) appendFileSync(file, '\n', { mode: 0o600 });
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
          this.index(JSON.parse(line) as DecisionLine);
        } catch {
          // A torn last line (crash mid-append) is skipped; every complete line still folds.
        }
      }
    }
  }

  private index(line: DecisionLine): void {
    if (line.op === 'record') {
      if (this.byId.has(line.id)) return;
      this.byId.set(line.id, { record: line, outcomes: [] });
      if (line.derived.key !== null) {
        const ids = this.byKey.get(line.derived.key) ?? [];
        ids.push(line.id);
        this.byKey.set(line.derived.key, ids);
      }
      return;
    }
    const folded = this.byId.get(line.id);
    if (folded === undefined) return;
    folded.outcomes.push(line);
    if (line.proposal_id !== undefined) this.byProposal.set(line.proposal_id, line.id);
  }

  private write(projectId: string | null, line: DecisionLine): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const file = this.fileFor(projectId);
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  appendRecord(record: DecisionRecord): void {
    this.load();
    this.write(record.project_id, record);
    this.index(record);
  }

  appendOutcome(outcome: DecisionOutcome): void {
    this.load();
    const folded = this.byId.get(outcome.id);
    if (folded === undefined) throw new Error(`decision ${outcome.id} is not in the ledger`);
    this.write(folded.record.project_id, outcome);
    this.index(outcome);
  }

  record(id: string): DecisionRecord | null {
    this.load();
    return this.byId.get(id)?.record ?? null;
  }

  outcomes(id: string): DecisionOutcome[] {
    this.load();
    return [...(this.byId.get(id)?.outcomes ?? [])];
  }

  /** The decision a review-queue proposal was filed for, or `null` (an ordinary proposal). */
  decisionForProposal(proposalId: string): string | null {
    this.load();
    return this.byProposal.get(proposalId) ?? null;
  }

  /** Prior records with this key: how often, since when, and in which projects. */
  recurrence(key: string): { count: number; first_at: number; projects: string[] } | null {
    this.load();
    const ids = this.byKey.get(key);
    if (ids === undefined || ids.length === 0) return null;
    const records = ids.map((i) => this.byId.get(i)?.record).filter((r): r is DecisionRecord => r !== undefined);
    const projects = [...new Set(records.map((r) => r.project_id).filter((p): p is string => p !== null))].sort();
    return { count: records.length, first_at: Math.min(...records.map((r) => r.at)), projects };
  }

  /** Remembered, not undone decisions with this key, newest outcome last. */
  rememberedWithKey(key: string): Array<{ record: DecisionRecord; rule_id: string }> {
    this.load();
    const out: Array<{ record: DecisionRecord; rule_id: string }> = [];
    for (const id of this.byKey.get(key) ?? []) {
      const view = this.view(id);
      const folded = this.byId.get(id);
      if (view === null || folded === undefined) continue;
      if (view.state === 'remembered' && view.rule_id !== undefined) out.push({ record: folded.record, rule_id: view.rule_id });
    }
    return out;
  }

  /** Records whose route asks for an action but carry no outcome yet (the restart re-drive). */
  pending(): DecisionRecord[] {
    this.load();
    return [...this.byId.values()]
      .filter((f) => f.outcomes.length === 0 && f.record.route !== 'ledger')
      .map((f) => f.record);
  }

  view(id: string): DecisionView | null {
    this.load();
    const folded = this.byId.get(id);
    if (folded === undefined) return null;
    return foldView(folded, this);
  }

  list(filter: DecisionFilter = {}): DecisionView[] {
    this.load();
    const out: DecisionView[] = [];
    for (const folded of this.byId.values()) {
      const r = folded.record;
      if (filter.project !== undefined && r.project_id !== filter.project) continue;
      if (filter.chat !== undefined && r.origin.chat_id !== filter.chat) continue;
      if (filter.run !== undefined && r.origin.run_id !== filter.run) continue;
      if (filter.since !== undefined && r.at < filter.since) continue;
      const view = foldView(folded, this);
      if (filter.state !== undefined && view.state !== filter.state) continue;
      out.push(view);
    }
    return out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  }
}

function foldView(folded: Folded, ledger: DecisionLedger): DecisionView {
  const r = folded.record;
  const view: DecisionView = {
    id: r.id,
    at: r.at,
    project_id: r.project_id,
    host: r.host,
    origin: {
      actor: r.origin.actor,
      auth_mode: r.origin.auth_mode,
      ...(r.origin.run_id !== undefined ? { run_id: r.origin.run_id } : {}),
      ...(r.origin.ord !== undefined ? { ord: r.origin.ord } : {}),
      ...(r.origin.gate_id !== undefined ? { gate_id: r.origin.gate_id } : {}),
      ...(r.origin.elicitation_id !== undefined ? { elicitation_id: r.origin.elicitation_id } : {}),
      ...(r.origin.chat_id !== undefined ? { chat_id: r.origin.chat_id } : {}),
      ...(r.origin.turn_id !== undefined ? { turn_id: r.origin.turn_id } : {}),
      words: r.origin.words,
      ...(r.origin.choice !== undefined ? { choice: r.origin.choice } : {}),
      words_source: r.origin.words_source,
      redacted: r.origin.redacted,
    },
    derived: {
      statement: r.derived.statement,
      polarity: r.derived.polarity,
      key: r.derived.key,
      scope: r.derived.scope,
      steering_type: r.derived.steering_type,
      template: r.labels.deterministic.template,
      exclusions: r.labels.deterministic.exclusions,
    },
    route: r.route,
    state: 'recorded',
    ...(r.route === 'conflict' && r.rule_ref !== undefined ? { conflicts_rule_id: r.rule_ref } : {}),
    ...((r.route === 'restated' || r.route === 'maybe-restated') && r.rule_ref !== undefined ? { restates_rule_id: r.rule_ref } : {}),
  };
  for (const o of folded.outcomes) {
    view.state = o.state;
    if (o.how !== undefined) view.how = o.how;
    if (o.proposal_id !== undefined) view.proposal_id = o.proposal_id;
    if (o.rule_id !== undefined) view.rule_id = o.rule_id;
    if (o.restates_rule_id !== undefined) view.restates_rule_id = o.restates_rule_id;
    if (o.edits !== undefined) {
      const edits: NonNullable<DecisionView['edits']> = { ...(view.edits ?? {}) };
      if (o.edits.statement !== undefined) edits.statement = o.edits.statement;
      if (o.edits.scope !== undefined) edits.scope = o.edits.scope;
      if (o.edits.steering_type !== undefined) edits.steering_type = o.edits.steering_type;
      view.edits = edits;
    }
    if (o.state === 'landing_failed' && o.error !== undefined) view.error = o.error;
    else delete view.error;
  }
  // B8: the same key decided in ≥ 2 projects → offer "Make it apply everywhere".
  if (r.derived.key !== null && r.project_id !== null && view.state !== 'widened') {
    const projects = ledger.recurrence(r.derived.key)?.projects ?? [];
    if (projects.length >= 2) view.widen = { projects };
  }
  return view;
}
