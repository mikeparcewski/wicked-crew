/**
 * (CONTRACT-CS2 §P2, DES-APPS-001 §9.3) The publish check proper: the check unit of an `apps-publish` run.
 *
 * It reads the persisted publish (P1 step 3), re-runs the turn check read-only on the persisted tree (the
 * per-kind source check and the live row-write table safety check are the turn check's; nothing lands),
 * rebuilds the manifest from the persisted body and requires the SAME digest (a source or grant that changed
 * since the launch is `manifest_changed`), generates the consent card for every action from fixture values
 * (the pure builder, apps/actions/card.ts — no record, no rate limit, no source call), and renders the fixture
 * at two viewports as the QE evidence. Any render it cannot run answers `render_unavailable`; it never passes
 * on a render that did not happen.
 *
 * A2 owns this module and defines {@link PublishCheckDeps} as the narrow surface it needs from A1's store, so
 * A1 can pass the store. A1 persists the publish and wires the deps; B provides `appsRuntime()`.
 */

import type { AppAction, AppActionCard, AppActionGrant, AppAudienceRule, AppManifestSource, AppLock, AppParamSchema, AppValue, AppActionCardValue, AppPublishManifest } from '../../core/types.js';
import { buildApiCard, buildRowCard, cardCell } from '../actions/card.js';
import { mutationField } from '../actions/api-action.js';
import { bindParams, type Viewer } from '../exec/params.js';
import { canonicalJson } from '../../mcp/classify.js';
import type { AppFiles, CheckOutcome } from '../check.js';
import type { ImageSources } from './layout.js';
import type { ManifestOutcome } from './manifest.js';
import { renderFixture, type RenderInput, type RenderReport, type RenderResult } from './render.js';

/** One rule the check looked at, and how it came out (the `report` lists every one). */
export interface PublishRule {
  rule: string;
  ok: boolean;
  detail?: string;
}

export interface PublishReport {
  tree: string;
  digest: string;
  rules: PublishRule[];
  render: RenderReport;
}

export type PublishCheckAnswer =
  | { ok: true; tree: string; digest: string; report: PublishReport; evidence: Array<{ path: string; base64: string }>; card: string }
  | { ok: false; code: 'check_failed' | 'source_check_unavailable' | 'render_unavailable'; findings: Array<{ code: string; path?: string; message: string }> };

/** The persisted publish (P1 step 3), as the check reads it. A1's store holds and persists it. */
export interface PublishRecord {
  runId: string;
  slug: string;
  base: number;
  tree: string;
  commit: string;
  manifest: AppPublishManifest;
  digest: string;
  sources: ImageSources;
}

/**
 * What the publish check needs from A1's store. A1 passes the store (it satisfies this). Kept narrow on
 * purpose: the persisted publish, the read-only parts of the turn check, the manifest rebuild, and the
 * standalone runtime (B's `appsRuntime()`). A `render` seam is injectable for tests.
 */
export interface PublishCheckDeps {
  /** The persisted publish for this run, or `null`. */
  publishOf: (runId: string) => PublishRecord | null;
  /** The checked files of the persisted tree (read-only: spec, query text, lock). */
  filesOf: (tree: string) => Promise<AppFiles>;
  /** Re-run the turn's staged check on the tree (per-kind source check + live row-write table safety). No land. */
  recheck: (tree: string) => Promise<CheckOutcome>;
  /** Rebuild the manifest from the persisted body and the live sources/grants (buildManifest). */
  rebuildManifest: (rec: PublishRecord, lock: AppLock) => Promise<ManifestOutcome>;
  /** B's `appsRuntime()`: the standalone runtime dir and JS/CSS contents, or `null` when it is not bundled. */
  runtime: () => { dir: string; js: string; css: string } | null;
  /** TESTS: override the render harness. */
  render?: (input: RenderInput) => Promise<RenderResult>;
  env?: NodeJS.ProcessEnv;
}

const finding = (code: string, message: string, path?: string): { code: string; path?: string; message: string } => (path === undefined ? { code, message } : { code, path, message });

export async function publishCheck(deps: PublishCheckDeps, input: { slug: string; runId: string }): Promise<PublishCheckAnswer> {
  const rec = deps.publishOf(input.runId);
  if (rec === null || rec.slug !== input.slug) {
    return { ok: false, code: 'check_failed', findings: [finding('no_publish', `run ${input.runId} is not a publish run of ${input.slug}`)] };
  }
  const rules: PublishRule[] = [];
  const note = (rule: string, ok: boolean, detail?: string): void => {
    rules.push(detail === undefined ? { rule, ok } : { rule, ok, detail });
  };

  // The persisted tree is the one checked, re-read from the app repo's own objects.
  let files: AppFiles;
  try {
    files = await deps.filesOf(rec.tree);
  } catch (err) {
    return { ok: false, code: 'check_failed', findings: [finding('unreadable_tree', `the published tree ${rec.tree} no longer reads back from ${input.slug}`, err instanceof Error ? err.message : undefined)] };
  }
  note('tree_still_published', rec.manifest.app.tree === rec.tree, rec.manifest.app.tree === rec.tree ? undefined : 'the manifest names another tree');
  if (rec.manifest.app.tree !== rec.tree) {
    return { ok: false, code: 'check_failed', findings: [finding('manifest_changed', 'the persisted manifest names a different tree than the publish run')] };
  }

  // Compare the fresh contracts and validate live grants against that lock; nothing is written.
  const validate = async (): Promise<Extract<PublishCheckAnswer, { ok: false }> | null> => {
    const outcome = await deps.recheck(rec.tree);
    note('turn_check', outcome.ok, outcome.ok ? undefined : outcome.code);
    if (!outcome.ok) return { ok: false, code: outcome.code, findings: outcome.findings.map((f) => finding(f.code, f.message, f.path)) };
    const sameLock = canonicalJson(outcome.lock) === canonicalJson(files.lock);
    note('fresh_contracts', sameLock);
    if (!sameLock) return { ok: false, code: 'check_failed', findings: [finding('manifest_changed', 'the live source, query or action contracts changed since this tree was checked. Check and publish again.')] };
    const rebuilt = await deps.rebuildManifest(rec, outcome.lock);
    if (!rebuilt.ok) return { ok: false, code: 'check_failed', findings: rebuilt.findings.map((f) => finding(f.code, f.message)) };
    const same = rebuilt.digest === rec.digest;
    note('manifest_digest', same);
    if (!same) return { ok: false, code: 'check_failed', findings: [finding('manifest_changed', 'a source or grant changed since the publish was launched: the manifest no longer matches. Publish again.')] };
    return null;
  };
  const invalid = await validate();
  if (invalid !== null) return invalid;

  // The consent card for every action, from deterministic fixture values (no record, no rate, no source call).
  const spec = files.spec;
  const cards: Record<string, AppActionCard> = {};
  try {
    for (const action of spec.actions) cards[action.id] = fixtureCardFor(action, rec.manifest, input.slug, rec.sources);
  } catch (err) {
    return { ok: false, code: 'check_failed', findings: [finding('fixture_invalid', err instanceof Error ? err.message : String(err))] };
  }
  note('action_cards', true, `${spec.actions.length} action card${spec.actions.length === 1 ? '' : 's'}`);

  // The render. No runtime (or no browser) means the evidence cannot be produced: render_unavailable, never ok.
  const runtime = deps.runtime();
  if (runtime === null) {
    note('render', false, 'no standalone runtime');
    return { ok: false, code: 'render_unavailable', findings: [finding('render_unavailable', 'the standalone runtime is not bundled with this crew, so the fixture cannot be rendered')] };
  }
  const render = deps.render ?? renderFixture;
  const result = await render({ runtime, fixture: { spec, cards }, ...(deps.env !== undefined ? { env: deps.env } : {}) });
  note('render', result.ok, result.ok ? `${result.report.pages.length} page render${result.report.pages.length === 1 ? '' : 's'}` : result.reason);
  if (!result.ok) {
    return { ok: false, code: 'render_unavailable', findings: [finding('render_unavailable', result.reason)] };
  }

  // A render can take three minutes. Recheck contracts and grants immediately before answering success.
  const changed = await validate();
  if (changed !== null) return changed;

  const report: PublishReport = { tree: rec.tree, digest: rec.digest, rules, render: result.report };
  return { ok: true, tree: rec.tree, digest: rec.digest, report, evidence: result.evidence, card: consentCard(rec.manifest, spec.actions, cards) };
}

/** Fixture identity goes through the same binding and validation rules as live prepareAction. */
export const FIXTURE_VIEWER: Viewer = { id: 'viewer-00000000', email: 'viewer@example.test', name: 'Sample Viewer', groups: ['support-ops'] };
const FIXTURE_UUID = '00000000-0000-4000-8000-000000000000';

/** A pure presentation: resolved fixture values and persisted source metadata, never a source call. */
export function fixtureCardFor(action: AppAction, manifest: AppPublishManifest, app: string, sources?: ImageSources): AppActionCard {
  const supplied = Object.fromEntries(Object.entries(action.params?.properties ?? {}).filter(([, decl]) => decl.from === undefined).map(([name, decl]) => [name, sampleParam(name, decl)]));
  const bound = bindParams(action.params, supplied, FIXTURE_VIEWER);
  const now = new Date('2026-01-01T00:00:00.000Z');
  const value = (v: AppValue) => cardCell(v, action.params, {
    paramValue: (name) => bound.byName[name],
    viewerClaim: (claim) => FIXTURE_VIEWER[claim],
    newUuid: () => FIXTURE_UUID,
  });
  const source = sources?.sources[action.source];
  if (action.kind === 'row-write') {
    const cells = (vs: Record<string, AppValue>): AppActionCardValue[] => Object.entries(vs).map(([name, v]) => {
      const c = value(v);
      return { name, ...c, value: (v.kind === 'crew' && v.value === 'now' ? now.toISOString() : c.value) as AppActionCardValue['value'] };
    });
    // The fixture shows a declared template. Column casts are resolved and verified by live prepare.
    const card = buildRowCard(app, action, { login: source?.config.sql?.user ?? '', columns: cells(action.set ?? {}), key: cells(action.key), statement: fixtureStatement(action), checks: 'plain table: no triggers, rules, inheritance or row security; fixture declaration (live prepare checks the table and value types)' });
    return card;
  }
  if (source === undefined) throw new Error(`fixture action ${action.id} has no source metadata (${manifest.sources.find((s) => s.name === action.source)?.kind ?? action.source})`);
  const tool = action.call.kind === 'tool' ? source.tools.find((t) => t.name === (action.call.kind === 'tool' ? action.call.tool : '')) : undefined;
  if (action.call.kind === 'tool' && tool === undefined) throw new Error(`fixture action ${action.id} has no tool metadata`);
  return buildApiCard(app, action, { config: source.config, ...(tool !== undefined ? { tool } : {}), ...(action.call.kind === 'mutation' ? { field: mutationField(action.call.mutation).name } : {}) }, value, now, bound.absent, FIXTURE_UUID).card;
}

/** A declaration template: column casts and returning checks belong to live table resolution. */
function fixtureStatement(action: Extract<AppAction, { kind: 'row-write' }>): string {
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const table = action.table.split('.').map(quote).join('.');
  const set = Object.keys(action.set ?? {});
  const key = Object.keys(action.key);
  if (action.op === 'insert') return `INSERT INTO ${table} (${set.map(quote).join(', ')}) VALUES (${set.map((_, i) => `$${i + 1}`).join(', ')})`;
  const offset = action.op === 'update' ? set.length : 0;
  const where = key.map((k, i) => `${quote(k)} = $${offset + i + 1}`).join(' AND ');
  if (action.op === 'delete') return `DELETE FROM ONLY ${table} WHERE ${where}`;
  return `UPDATE ONLY ${table} SET ${set.map((c, i) => `${quote(c)} = $${i + 1}`).join(', ')} WHERE ${where}`;
}

/** Deterministic inputs; bindParams rejects any schema for which these cannot be valid. */
function sampleParam(name: string, decl: AppParamSchema): AppActionCardValue['value'] {
  if (decl.default !== undefined) return decl.default;
  if (decl.enum !== undefined && decl.enum.length > 0) return decl.enum[0]!;
  switch (decl.type) {
    case 'array': return [decl.items?.type === 'integer' || decl.items?.type === 'number' ? 1 : 'sample'];
    case 'integer': return Math.ceil(Math.max(decl.minimum ?? -Number.MAX_SAFE_INTEGER, Math.min(decl.maximum ?? Number.MAX_SAFE_INTEGER, 1)));
    case 'number': return Math.max(decl.minimum ?? -Number.MAX_VALUE, Math.min(decl.maximum ?? Number.MAX_VALUE, 1.5));
    case 'boolean': return true;
    default: {
      const formats = { email: 'sample@example.test', uuid: FIXTURE_UUID, date: '2026-01-01', 'date-time': '2026-01-01T00:00:00Z' };
      if (decl.format === 'email') {
        const domain = '@b.co';
        const length = Math.max(decl.minLength ?? 0, Math.min(decl.maxLength ?? 19, 19));
        if (length !== 19) return `${'a'.repeat(Math.max(1, length - domain.length))}${domain}`;
      }
      if (decl.format !== undefined) return formats[decl.format];
      const sample = `sample ${name}`;
      return sample.slice(0, decl.maxLength ?? sample.length).padEnd(decl.minLength ?? 0, 'x');
    }
  }
}

/** Who can open the site, in one line (the same shape `AppPublished.audience` carries). */
export function audienceLine(a: AppAudienceRule, issuer: string | null): string {
  switch (a.kind) {
    case 'public':
      return 'Anyone (public, read-only)';
    case 'oidc-groups':
      return `People in ${a.groups.length === 1 ? 'group' : 'groups'} ${a.groups.join(', ')}${issuer !== null ? ` who sign in at ${issuer}` : ''}`;
    case 'oidc-email-domain':
      return `People with an email at ${a.domains.join(', ')}${issuer !== null ? ` who sign in at ${issuer}` : ''}`;
    case 'entra-roles':
      return `People with app ${a.roles.length === 1 ? 'role' : 'roles'} ${a.roles.join(', ')}`;
    case 'entra-groups':
      return `People in Entra ${a.groups.length === 1 ? 'group' : 'groups'} ${a.groups.join(', ')}`;
    default:
      return 'an unknown audience';
  }
}

const sourceReach = (s: AppManifestSource): string => (s.snapshot !== undefined ? 'a snapshot shipped in the image' : s.reach ?? 'no address');

/**
 * The consent card text (DES §9.3 step 3): targets, audience + issuer, each source with its descriptor and
 * reach, each query (public or not), each action with its card template and grant, env names, embed origins,
 * snapshots shipped. This is the text studio shows and the CLI prints.
 */
export function consentCard(m: AppPublishManifest, declarations: AppAction[] = [], cards: Record<string, AppActionCard> = {}): string {
  const lines: string[] = [];
  lines.push(`Publish ${m.app.name} v${m.app.version}`);
  lines.push(`Where: ${m.targets.join(', ')} — ${m.site.origin}`);
  lines.push(`Who can open it: ${audienceLine(m.audience, m.identity?.issuer ?? null)}`);
  if (m.identity !== null) lines.push(`Sign-in: ${m.identity.profile} at ${m.identity.issuer} (client ${m.identity.clientId})`);
  if (m.embedOrigins.length > 0) lines.push(`Embed origins: ${m.embedOrigins.join(', ')}`);
  lines.push('Sources shipped:');
  if (m.sources.length === 0) lines.push('  (none)');
  for (const s of m.sources) {
    const bits = [`${s.kind}`, `reach ${sourceReach(s)}`, `descriptor ${s.descriptorHash.slice(0, 12)}`];
    if (s.env !== null) bits.push(`secret in ${s.env}`);
    if (s.allowWrites) bits.push('Allow writes on');
    if (s.snapshot !== undefined) bits.push(`snapshot ${s.snapshot.slice(0, 12)}`);
    lines.push(`  ${s.name}: ${bits.join(', ')}`);
  }
  lines.push('Queries:');
  if (m.queries.length === 0) lines.push('  (none)');
  for (const q of m.queries) lines.push(`  ${q.id} (${q.source}): ${q.public ? 'public' : 'signed-in'}`);
  lines.push('Actions:');
  if (m.actions.length === 0) lines.push('  (none)');
  for (const a of m.actions) {
    const what = a.kind === 'row-write' ? `${a.table} (${(a.columns ?? []).join(', ') || 'no columns'})` : a.source;
    lines.push(`  ${a.id} [${a.kind}] on ${what}, granted by ${grantor(a.grant)}`);
    const declaration = declarations.find((d) => d.id === a.id);
    if (declaration !== undefined) lines.push(`    Template: ${JSON.stringify(declaration)}`);
    if (cards[a.id] !== undefined) lines.push(`    Fixture card: ${JSON.stringify(cards[a.id])}`);
    lines.push(`    Grant binding: ${JSON.stringify(a.grant)}`);
  }
  lines.push(`Environment names: ${m.env.length > 0 ? m.env.join(', ') : '(none)'}`);
  lines.push(`Data volume: ${m.volume ?? '(none)'}`);
  return lines.join('\n');
}

const grantor = (g: AppActionGrant): string => {
  const by = g.grantedBy;
  return typeof by === 'object' && by !== null && 'id' in by ? String((by as { id: unknown }).id) : 'someone';
};
