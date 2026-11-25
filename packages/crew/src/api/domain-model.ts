/**
 * (J6 K1) The domain model a repository's estate store holds, schema 1.2.0, as `wicked-core domain-graph` writes it
 * (wicked-core `crates/wicked-governance/src/domain_extract.rs`, `build_model`), read for `GET /repos/:id/requirements`;
 * and a person's ruling on it (`POST /repos/:id/requirements/rulings`), which core writes and rebuilds the model from
 * (`Core.domainRuling`). The document is the one source: nothing here keeps state, and a ruling is never overlaid at
 * read time.
 */
import type {
  DomainClaim,
  DomainFollowup,
  DomainGroupSentence,
  DomainModel,
  DomainRange,
  DomainRejectedStatement,
  DomainRuleGroup,
  DomainRuling,
  DomainRulingBody,
  DomainRulingResponse,
  DomainStatement,
  DomainTarget,
  DomainWithheldSentence,
} from 'wicked-crew-api-types';

/** The schema version whose documents carry the model. */
export const DOMAIN_MODEL_V3 = '1.2.0';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ints = (v: unknown): number[] | undefined => (Array.isArray(v) ? v.filter((x): x is number => int(x) !== null) : undefined);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');

function rangeOf(v: unknown): DomainRange | null {
  if (!isObj(v)) return null;
  const file = str(v['file']);
  const from = int(v['from']);
  const to = int(v['to']);
  return file !== null && from !== null && to !== null ? { file, from, to } : null;
}

function rangesOf(v: unknown): DomainRange[] {
  return arr(v).map(rangeOf).filter((r): r is DomainRange => r !== null);
}

/** A ruling as the doc carries it (`{action, by, at, note?}`); anything else is no ruling. */
export function rulingOf(v: unknown): DomainRuling | null {
  if (!isObj(v)) return null;
  const action = v['action'];
  const by = str(v['by']);
  const at = int(v['at']);
  if ((action !== 'confirm' && action !== 'reject') || by === null || at === null) return null;
  const note = str(v['note']);
  return { action, by, at, ...(note !== null ? { note } : {}) };
}

function claimOf(v: unknown): DomainClaim | null {
  if (!isObj(v)) return null;
  const i = int(v['i']);
  const type = str(v['type']);
  const text = str(v['text']);
  if (i === null || type === null || text === null) return null;
  const when = ints(v['when']);
  const unless = ints(v['unless']);
  const guards = rangesOf(v['guard_ranges']);
  const of = v['of'];
  return {
    i, type, text,
    ...(when !== undefined ? { when } : {}),
    ...(unless !== undefined ? { unless } : {}),
    ...(of === null || int(of) !== null ? { of: of as number | null } : {}),
    ranges: rangesOf(v['ranges']),
    ...(guards.length > 0 ? { guardRanges: guards } : {}),
  };
}

const STATUSES = new Set(['Checked', 'open', 'confirmed', 'stale']);

function statementOf(v: unknown, requirementKey: string): DomainStatement | null {
  if (!isObj(v)) return null;
  const id = str(v['id']);
  const key = str(v['statement_key']);
  const status = str(v['status']);
  const text = str(v['statement']);
  if (id === null || key === null || status === null || !STATUSES.has(status) || text === null) return null;
  const checkedBy = v['checked_by'];
  return {
    id, key, requirementKey,
    status: status as DomainStatement['status'],
    text,
    located: v['located'] === true,
    target: str(v['target']),
    sourceRef: str(v['source_ref']),
    claims: arr(v['claims']).map(claimOf).filter((c): c is DomainClaim => c !== null),
    checkedBy: checkedBy === 'codex' || checkedBy === 'you' ? checkedBy : null,
    ruling: rulingOf(v['ruling']),
  };
}

function sentenceOf(v: unknown): DomainGroupSentence | null {
  if (!isObj(v)) return null;
  const id = str(v['id']);
  const text = str(v['text']);
  return id !== null && text !== null ? { id, text, cites: strs(v['cites']) } : null;
}

function groupOf(v: unknown): DomainRuleGroup | null {
  if (!isObj(v)) return null;
  const id = str(v['id']);
  if (id === null) return null;
  const withheld = arr(v['withheld'])
    .map((w) => {
      const s = sentenceOf(w);
      return s === null || !isObj(w) ? null : { ...s, reason: str(w['reason']) ?? '' };
    })
    .filter((w): w is DomainWithheldSentence => w !== null);
  return {
    id,
    title: str(v['title']) ?? '',
    area: str(v['area']) ?? '',
    kind: str(v['kind']) ?? 'business',
    rule: sentenceOf(v['rule']),
    details: arr(v['details']).map(sentenceOf).filter((s): s is DomainGroupSentence => s !== null),
    withheld,
    stale: v['stale'] === true,
  };
}

function whereOf(v: unknown): DomainFollowup['where'] {
  if (!isObj(v)) return null;
  const file = str(v['file']);
  const lines = ints(v['lines']);
  return file !== null && lines !== undefined && lines.length === 2 ? { file, lines: [lines[0]!, lines[1]!] } : null;
}

function followupOf(v: unknown): DomainFollowup | null {
  if (!isObj(v)) return null;
  const id = str(v['id']);
  const kind = str(v['kind']);
  if (id === null || kind === null) return null;
  return {
    id,
    n: int(v['n']) ?? 0,
    kind,
    statement: str(v['statement']),
    target: str(v['target']),
    where: whereOf(v['where']),
    unknown: str(v['unknown']) ?? '',
    check: str(v['check']) ?? '',
    ruling: rulingOf(v['ruling']),
  };
}

function rejectedOf(v: unknown): DomainRejectedStatement | null {
  if (!isObj(v)) return null;
  const id = str(v['id']);
  const key = str(v['statement_key']);
  const ruling = rulingOf(v['ruling']);
  return id !== null && key !== null && ruling !== null ? { id, key, text: str(v['statement']) ?? '', ruling } : null;
}

function targetOf(v: unknown): DomainTarget | null {
  if (!isObj(v)) return null;
  const id = str(v['id']);
  const file = str(v['file']);
  const lines = ints(v['lines']);
  const targetHash = str(v['target_hash']);
  if (id === null || file === null || lines === undefined || lines.length !== 2 || targetHash === null) return null;
  return {
    id, file, lines: [lines[0]!, lines[1]!], targetHash,
    accounted: v['accounted'] === true,
    stale: v['stale'] === true,
    statements: strs(v['statements']),
    rejected: arr(v['rejected']).map(rejectedOf).filter((r): r is DomainRejectedStatement => r !== null),
    unaccountedReasons: strs(v['unaccounted_reasons']),
    ruling: rulingOf(v['ruling']),
  };
}

/**
 * The model of a 1.2.0 document, or `null` for any other (a 1.1.0 graph keeps the list it always had). An item the
 * reader cannot type is left out rather than guessed at; the counts are the document's own.
 */
export function domainModelOf(graph: unknown): DomainModel | null {
  if (!isObj(graph) || !isObj(graph['metadata'])) return null;
  const m = graph['metadata'];
  if (m['schema_version'] !== DOMAIN_MODEL_V3) return null;
  const acc = isObj(m['accounting']) ? m['accounting'] : {};
  const statements: DomainStatement[] = [];
  for (const [domain, dom] of Object.entries(isObj(graph['domains']) ? graph['domains'] : {})) {
    const reqs = isObj(dom) && isObj(dom['requirements']) ? dom['requirements'] : {};
    for (const [reqId, req] of Object.entries(reqs)) {
      for (const r of arr(isObj(req) ? req['business_rules'] : undefined)) {
        const st = statementOf(r, `${domain}::${reqId}`);
        if (st !== null) statements.push(st);
      }
    }
  }
  return {
    schemaVersion: DOMAIN_MODEL_V3,
    accounting: {
      targets: int(acc['targets']) ?? 0,
      accounted: int(acc['accounted']) ?? 0,
      open: int(acc['open']) ?? 0,
      stale: int(acc['stale']) ?? 0,
    },
    statements,
    ruleGroups: arr(m['rule_groups']).map(groupOf).filter((g): g is DomainRuleGroup => g !== null),
    followups: arr(m['followups']).map(followupOf).filter((f): f is DomainFollowup => f !== null),
    targets: arr(m['targets']).map(targetOf).filter((t): t is DomainTarget => t !== null),
    builtAt: int(m['built_at']),
  };
}

/** The request core's `domainRuling` reads (wicked-core `RulingRequest`), from the route's body and who made it. */
export function rulingRequestOf(body: DomainRulingBody, by: string): string {
  return JSON.stringify({
    ...(body.statement !== undefined ? { statement: body.statement } : {}),
    ...(body.target !== undefined ? { target: body.target } : {}),
    ...(body.expect !== undefined ? { expect_key: body.expect } : {}),
    expect_target_hash: body.expectTarget,
    action: body.action,
    ...(body.note !== undefined ? { note: body.note } : {}),
    by,
  });
}

/** What the route answers for core's one-line answer: the status and the body. */
export type RulingAnswer =
  | { status: 200; body: DomainRulingResponse }
  | { status: 400 | 404 | 409 | 500; body: { error: string; code: string } };

const REFUSAL_STATUS: Record<string, 400 | 404 | 409> = {
  bad_request: 400,
  note_required: 400,
  not_found: 404,
  stale_code: 409,
  changed: 409,
  not_open: 409,
};

/** Core's answer (`{ok, ruling, build}` or `{ok: false, code, message}`) as the route's status and body. */
export function rulingAnswerOf(raw: string): RulingAnswer {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { status: 500, body: { error: 'the engine answered the ruling with something that is not JSON', code: 'engine' } };
  }
  if (!isObj(v)) return { status: 500, body: { error: 'the engine answered the ruling with no object', code: 'engine' } };
  if (v['ok'] !== true) {
    const code = str(v['code']) ?? 'engine';
    const error = str(v['message']) ?? 'the ruling was refused';
    return { status: REFUSAL_STATUS[code] ?? 500, body: { error, code } };
  }
  const r = isObj(v['ruling']) ? v['ruling'] : {};
  const ruling = rulingOf(r);
  const subject = r['subject'];
  const id = str(r['id']);
  if (ruling === null || (subject !== 'statement' && subject !== 'target') || id === null) {
    return { status: 500, body: { error: 'the engine saved a ruling this daemon cannot read', code: 'engine' } };
  }
  const b = isObj(v['build']) ? v['build'] : {};
  const acc = isObj(b['accounting']) ? b['accounting'] : null;
  const build: DomainRulingResponse['build'] = b['ok'] === true && acc !== null
    ? {
        rebuilt: true,
        accounting: {
          targets: int(acc['targets']) ?? 0,
          accounted: int(acc['accounted']) ?? 0,
          open: int(acc['open']) ?? 0,
          stale: int(acc['stale']) ?? 0,
        },
      }
    : { rebuilt: false, error: str(b['error']) ?? 'the ruling is saved; the model was not rebuilt' };
  return { status: 200, body: { ruling: { ...ruling, subject, id }, build } };
}

/** The preset a domain model run launches (garden's `domain-run` step, then core's graph build). */
export const DOMAIN_EXTRACTION_WORKFLOW = 'domain-extraction';

/** The most words a scope's intent takes (`LaunchRunBody.domainScope.intent`). */
export const DOMAIN_INTENT_MAX = 2000;

/**
 * (J6 K1, coord R2 F1-F3) The scope of a domain model launch made from a person's words alone (a chat job's Start, the
 * CLI's `--problem`, MCP's `problem`): the words are what the model covers, with no card shown and no hash, so the run
 * derives the scope from them. Or why the words cannot be one, said in words that end with `how` to fix it.
 */
export function domainScopeOfWords(words: string, how: string): { scope: { intent: string } } | { refusal: string } {
  const intent = words.trim();
  if (intent === '') return { refusal: `a domain model run needs to know what it should cover (a program, a job or a feature): ${how}` };
  if (intent.length > DOMAIN_INTENT_MAX) {
    return { refusal: `say what the model should cover in at most ${DOMAIN_INTENT_MAX.toLocaleString('en-US')} characters (these words have ${intent.length.toLocaleString('en-US')}): ${how}` };
  }
  return { scope: { intent } };
}

/** A launch's scope as core's `scopeJson` carries it to the run's domain-run step (garden `scope.py` reads it). */
export function domainScopeJsonOf(s: { intent: string; phrases?: string[] | undefined; scopeHash?: string | undefined; description?: string | undefined }): string {
  return JSON.stringify({
    intent: s.intent,
    ...(s.phrases !== undefined ? { phrases: s.phrases } : {}),
    ...(s.scopeHash !== undefined ? { scope_hash: s.scopeHash } : {}),
    ...(s.description !== undefined ? { description: s.description } : {}),
  });
}
