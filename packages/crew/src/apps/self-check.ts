import type { AppCheckFinding } from '../core/types.js';
import { appFilesFromBlobs, LOCK_PATH } from './check.js';
import type { AppStore } from './store.js';

export const APPS_SELF_CHECK_MAX = 3;
const TURNS_MAX = 4096;

export interface AppsCheckUnit {
  runId: string;
  phase: string;
  ord: number;
  attempt: number;
  seat: string;
}

export type AppsUnitVerifier = (token: string) => Promise<AppsCheckUnit | null>;

/** The builder's advisory check. Only the later check step can offer a tree for review. */
export class AppsSelfCheck {
  private readonly turns = new Map<string, { used: number; busy: boolean }>();

  constructor(
    private readonly store: AppStore,
    private readonly verifyUnitToken: AppsUnitVerifier,
    private readonly deps: {
      visibleSources: (projectId: string | null) => Promise<ReadonlySet<string>>;
      capacity?: number;
    },
  ) {}

  async resolve(token: string): Promise<AppsCheckUnit> {
    const unit = await this.verifyUnitToken(token);
    if (unit === null) throw new Error('invalid_token: the unit token is not valid');
    return unit;
  }

  async run(token: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const unit = await this.resolve(token);
    const prior = this.turns.get(unit.runId);
    const remaining = () => APPS_SELF_CHECK_MAX - (this.turns.get(unit.runId)?.used ?? 0);
    const refuse = (code: string, message: string) => this.refused(code, [{ stage: 'files', code, path: '$', message }], remaining());
    if (unit.phase !== 'build') return refuse('not_the_build', 'only the build step can run the Apps self-check');
    const slug = this.store.turnApp(unit.runId);
    if (slug === null) return refuse('not_a_turn', 'this run is not an app turn in flight');
    if (prior?.busy === true) return refuse('busy', 'this turn already has a self-check in flight');
    if (remaining() === 0) return refuse('self_check_limit', `this turn has made its ${APPS_SELF_CHECK_MAX} self-checks`);
    if (prior === undefined) {
      const capacity = this.deps.capacity ?? TURNS_MAX;
      if (this.turns.size >= capacity) {
        for (const runId of this.turns.keys()) if (this.store.turnApp(runId) === null) this.turns.delete(runId);
        if (this.turns.size >= capacity) return refuse('busy', 'the self-check is busy; try again');
      }
    }
    const state = { used: (prior?.used ?? 0) + 1, busy: true };
    this.turns.delete(unit.runId);
    this.turns.set(unit.runId, state);
    try {
      const files = args['files'];
      if (Object.keys(args).length !== 1 || files === null || typeof files !== 'object' || Array.isArray(files)) {
        return refuse('bad_args', 'the self-check arguments must be { "files": { "<path>": "<text>" } }');
      }
      const entries = Object.entries(files);
      if (entries.filter(([path]) => path !== LOCK_PATH).length > 101) return refuse('bad_tree', 'the files hold more than 101 entries');
      const textFindings: AppCheckFinding[] = [];
      const blobs = new Map<string, Buffer | AppCheckFinding>();
      for (const [path, text] of entries) {
        if (typeof text === 'string') blobs.set(path, Buffer.from(text, 'utf8'));
        else {
          const finding: AppCheckFinding = { stage: 'files', code: 'not_a_file', path, message: `${path} is not a text file` };
          textFindings.push(finding);
          blobs.set(path, finding);
        }
      }
      const read = appFilesFromBlobs(blobs);
      if (!read.ok || textFindings.length > 0) {
        const findings = read.ok ? [] : read.findings;
        return this.refused('check_failed', [...findings, ...textFindings.filter((f) => !findings.some((g) => g.path === f.path && g.code === f.code))], remaining());
      }
      const visible = await this.deps.visibleSources(this.store.projectOf(slug));
      const findings: AppCheckFinding[] = [];
      for (const kind of ['queries', 'actions'] as const) {
        read.files.spec[kind].forEach((item, i) => {
          if (item.source === 'estate' || item.source === 'crew' || visible.has(item.source)) return;
          findings.push({ stage: 'source', code: 'unknown_source', path: `$.${kind}[${i}].source`, message: `${item.source} is no source this app's builder may use: build on a source in the knowledge package` });
        });
      }
      if (findings.length > 0) return this.refused('check_failed', findings, remaining());
      const outcome = await this.store.selfCheckTurn(slug, unit.runId, read.files);
      if (!outcome.ok) return this.refused(outcome.code, outcome.findings, remaining());
      return {
        ok: true, level: outcome.summary.level, checked: outcome.summary.checked, remaining: remaining(),
        note: "crew's check found nothing to refuse in these files. Nothing was written; the check step still runs on your worktree after the build.",
      };
    } finally {
      state.busy = false;
    }
  }

  private refused(code: string, findings: AppCheckFinding[], remaining: number): Record<string, unknown> {
    return {
      ok: false, code, findings: findings.slice(0, 50).map(({ stage, code, path, message }) => ({ stage, code, path, message })), remaining,
      note: `Fix every finding, then check again (${remaining} left). Nothing was written.`,
    };
  }
}
