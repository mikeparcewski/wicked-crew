/**
 * Deterministic guards on every skills write/enable (design v3 §API) — v1 has NO semantic analyzer;
 * these are the checks a file manager can decide from the manifest and the bytes alone, answered
 * identically on every daemon:
 *
 *   - name charset + prefix; name UNIQUE across the FULL catalog, disabled skills included
 *     (a manifest is keyed by name — a duplicate is a blocking collision, annotated with whether
 *     the skill it collides with is core-by-reference, so the UI can say why it matters);
 *   - the SKILL.md frontmatter parses and its `name` equals the path-derived name (a rename in
 *     place would desynchronize the manifest key, the invocation identity, and the directory);
 *   - disabling or renaming a core-by-reference skill is blocking — a governed run would dispatch
 *     a phase whose skill is gone from the snapshot;
 *   - a `SKILL.md` anywhere but a skill's root is blocking: it would create an unregistered nested
 *     skill through the parent's endpoint (nested ownership, v3 §6) — `POST /skills` adds skills;
 *   - an edit under `scripts/` or `schemas/` (a skill's own, or the root support tree) is allowed
 *     but a WARNING: those files back behavior, not prose, and every invocation shares them;
 *   - content that makes a skill non-portable (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_SKILL_DIR}`,
 *     cwd-relative scripts, `../` links, paths into another skill, a declared
 *     `requires-harness: claude`) is a warning PER REASON with `file:line` (F-079): the skill
 *     becomes Claude-only and leaves every non-Claude delivery view (`views/copilot/`, the
 *     per-launch `--skill` lists core builds).
 *
 * `{verdict, findings[]}` is the ONE result shape; a mutation with a `blocked` verdict writes nothing.
 * Publish-time validation (unresolved refs, core closure, drift) lives in the store — it needs the
 * whole tree.
 */

import type {
  SkillConflictFinding,
  SkillFindingKind,
  SkillFindingSeverity,
  SkillPortabilityReason,
  SkillVerdict,
} from '../core/types.js';
import { parseFrontmatter, SKILL_NAME_PREFIX } from './frontmatter.js';
import { portabilityIssuesOf, type PortabilityContext, type PortabilityHit, type PortabilityIssue } from './refs.js';

/** The name charset — a manifest key, a directory segment, and a URL path segment at once. */
export const SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Support-file prefixes inside a skill dir — behavior, not prose (design v3 §API). */
const SUPPORT_PREFIXES = ['scripts/', 'schemas/'];

/** The catalog facts the guards consult — structural, so the store hands its manifest in directly. */
export interface CatalogEntryView {
  core: boolean;
  enabled: boolean;
  dir: string;
}
export type CatalogView = Readonly<Record<string, CatalogEntryView>>;

export interface FindingAnchor {
  skill?: string | null;
  file?: string | null;
  line?: number | null;
  against?: { name: string; core: boolean };
  /** `non-portable` only: the reason this finding reports (api-types 0.34.0). */
  portabilityReason?: SkillPortabilityReason;
}

export function finding(
  kind: SkillFindingKind,
  severity: SkillFindingSeverity,
  explanation: string,
  evidence: string,
  anchor: FindingAnchor = {},
): SkillConflictFinding {
  return {
    kind,
    severity,
    skill: anchor.skill ?? null,
    file: anchor.file ?? null,
    line: anchor.line ?? null,
    againstSkill: anchor.against?.name ?? null,
    againstIsCore: anchor.against?.core ?? false,
    evidence,
    explanation,
    ...(anchor.portabilityReason === undefined ? {} : { portabilityReason: anchor.portabilityReason }),
  };
}

/** `blocked` when any finding blocks, `warnings` when any warns, `clear` otherwise. */
export function verdictOf(findings: ReadonlyArray<SkillConflictFinding>): SkillVerdict {
  if (findings.some((f) => f.severity === 'blocking')) return 'blocked';
  if (findings.length > 0) return 'warnings';
  return 'clear';
}

/** Charset + the `wicked-garden-` prefix with a non-empty remainder. */
export function nameGuard(name: string): SkillConflictFinding | null {
  if (!SKILL_NAME_RE.test(name)) {
    return finding(
      'name-invalid',
      'blocking',
      'a skill name is a manifest key, a directory segment, and a URL segment — only [A-Za-z0-9_-] is safe in all three',
      `name ${JSON.stringify(name)} does not match ${SKILL_NAME_RE.source}`,
      { skill: name },
    );
  }
  if (!name.startsWith(SKILL_NAME_PREFIX) || name.length === SKILL_NAME_PREFIX.length) {
    return finding(
      'name-invalid',
      'blocking',
      `workers invoke skills as \`${SKILL_NAME_PREFIX.slice(0, -1)}:<dir>\`; the frontmatter name must be \`${SKILL_NAME_PREFIX}<dir>\` so the manifest key and the invocation identity stay one thing`,
      `name ${JSON.stringify(name)} lacks the \`${SKILL_NAME_PREFIX}\` prefix (or has nothing after it)`,
      { skill: name },
    );
  }
  return null;
}

/** Unique across the FULL catalog, disabled skills included. */
export function collisionGuard(catalog: CatalogView, name: string): SkillConflictFinding | null {
  const existing = catalog[name];
  if (existing === undefined) return null;
  return finding(
    'name-collision',
    'blocking',
    existing.core
      ? 'this name is a core-by-reference skill (a registered workflow dispatches phases to it); replace it through its own replace action instead of adding a second definition'
      : 'the catalog already has a skill with this name (disabled skills count — the manifest is keyed by name); use replace to override it',
    `${name} exists at ${existing.dir} (${existing.enabled ? 'enabled' : 'disabled'})`,
    { skill: name, against: { name, core: existing.core } },
  );
}

/**
 * The SKILL.md body must carry parseable frontmatter whose `name` is exactly `expectedName`.
 * A mismatch on a core skill additionally reports `core-rename` — the workflow that names it
 * would dispatch into a void. `severity` lets publish-time validation downgrade a DISABLED
 * skill's defects to warnings (it is not in the snapshot).
 */
export function frontmatterGuard(
  skillMd: string | undefined,
  expectedName: string,
  opts: { isCore: boolean; file: string; severity?: SkillFindingSeverity },
): SkillConflictFinding[] {
  const severity = opts.severity ?? 'blocking';
  const anchor = { skill: expectedName, file: opts.file };
  if (skillMd === undefined) {
    return [
      finding(
        'missing-skill-md',
        severity,
        'a skill is its SKILL.md — the files map must include one at the skill root',
        `no SKILL.md at ${opts.file}`,
        anchor,
      ),
    ];
  }
  const parsed = parseFrontmatter(skillMd);
  if (!parsed.ok) {
    return [
      finding(
        'frontmatter-invalid',
        severity,
        'Claude Code discovers a skill from its frontmatter; a body it cannot parse is a skill that silently vanishes from every worker',
        `${opts.file} frontmatter: ${parsed.reason}`,
        anchor,
      ),
    ];
  }
  const declared = parsed.fields['name'];
  if (declared === undefined || declared === '') {
    return [
      finding(
        'frontmatter-invalid',
        severity,
        'the manifest is keyed by the frontmatter `name`',
        `${opts.file} frontmatter has no \`name\``,
        anchor,
      ),
    ];
  }
  if (declared !== expectedName) {
    const out = [
      finding(
        'name-mismatch',
        severity,
        `the frontmatter name must equal the path-derived name (\`${SKILL_NAME_PREFIX}<dir segments joined by '-'>\`) — the manifest key, the directory, and the invocation identity are one thing`,
        `frontmatter name ${JSON.stringify(declared)} ≠ expected ${JSON.stringify(expectedName)}`,
        anchor,
      ),
    ];
    if (opts.isCore) {
      out.push(
        finding(
          'core-rename',
          'blocking',
          'a registered workflow dispatches phases to this skill by name; renaming it strands those phases',
          `${expectedName} is core-by-reference`,
          { ...anchor, against: { name: expectedName, core: true } },
        ),
      );
    }
    return out;
  }
  return [];
}

/** A path under `scripts/` or `schemas/` → warning. `rel` is relative to the tree being edited. */
export function supportFileGuard(rel: string, skill: string | null): SkillConflictFinding | null {
  if (!SUPPORT_PREFIXES.some((p) => rel.startsWith(p))) return null;
  return finding(
    'support-file-edit',
    'warning',
    "support files back the skill's behavior (scripts run, schemas validate) and are shared by every invocation — an edit here changes what the skill DOES, not what it says",
    `edit under ${rel.split('/')[0] ?? rel}/: ${rel}`,
    { skill, file: rel },
  );
}

/** A `SKILL.md` anywhere but the skill root would create an unregistered nested skill → blocking. */
export function nestedSkillCreateGuard(rel: string, skill: string): SkillConflictFinding | null {
  if (rel === 'SKILL.md' || !rel.endsWith('/SKILL.md')) return null;
  return finding(
    'nested-skill-create',
    'blocking',
    "a SKILL.md defines a skill; placing one inside another skill's tree through that skill's endpoint would create a nested skill the manifest never registered — add skills with POST /skills",
    `${rel} would define a nested skill under ${skill}`,
    { skill, file: rel },
  );
}

/** One sentence per reason token (design W4 §5.1) — the "why" the finding and the studio drawer show. */
export const PORTABILITY_EXPLANATION: Record<PortabilityIssue, string> = {
  'plugin-root': 'the content resolves `${CLAUDE_PLUGIN_ROOT}`, which only Claude Code substitutes — write the skill\'s own files relative to its base directory and reach shared scripts through `wicked-garden run …`',
  'skill-dir-var': 'the content resolves `${CLAUDE_SKILL_DIR}`, which only Claude Code substitutes — every CLI announces the skill\'s base directory, so a plain relative path is the portable spelling',
  'cwd-script': 'the content invokes a plugin script by a path relative to the worktree cwd, which only the Claude plugin path arranges — the launcher form `wicked-garden run <scripts-relative path>` resolves the plugin root on every CLI',
  'relative-link': 'the content links a file via `../`, which the flat `<name>/SKILL.md` layout of every non-Claude install cannot follow',
  'cross-skill-path': 'the content reaches ANOTHER skill by filesystem path; skills are laid out flat by name outside Claude Code, so name the skill (`wicked-garden-<x>`, "its `refs/x.md`") instead',
  'requires-harness:claude': 'the frontmatter declares `metadata.requires-harness: claude` — the author says this skill genuinely needs the Claude harness',
};

/** The tail every `non-portable` explanation shares. */
const NON_PORTABLE_CONSEQUENCE =
  "the skill becomes Claude-only — excluded from the snapshot's copilot view and from the per-launch skill lists core builds for pi/opencode, so a non-Claude seat that requires it is refused at launch";

/**
 * Content that makes a skill non-portable → ONE warning per reason per file, anchored at the first
 * line the reason occurs on (further hits are counted in the evidence). `ctxFor` answers the
 * validator's context for a skill-relative path (where the file sits, what exists in the bundle).
 */
export function nonPortableGuard(
  files: Readonly<Record<string, string>>,
  skill: string,
  ctxFor: (rel: string) => PortabilityContext,
): SkillConflictFinding[] {
  const out: SkillConflictFinding[] = [];
  for (const rel of Object.keys(files).sort()) {
    const ctx = ctxFor(rel);
    const hits = portabilityIssuesOf(files[rel] ?? '', ctx);
    const byReason = new Map<PortabilityIssue, PortabilityHit[]>();
    for (const hit of hits) {
      const list = byReason.get(hit.reason);
      if (list === undefined) byReason.set(hit.reason, [hit]);
      else list.push(hit);
    }
    for (const reason of [...byReason.keys()].sort()) {
      const list = byReason.get(reason) ?? [];
      const first = list[0];
      if (first === undefined) continue;
      out.push(
        finding(
          'non-portable',
          'warning',
          `${PORTABILITY_EXPLANATION[reason]}; ${NON_PORTABLE_CONSEQUENCE}`,
          `${ctx.fileRel}:${first.line}: ${reason} — ${first.evidence}${list.length > 1 ? ` (+${list.length - 1} more)` : ''}`,
          { skill, file: rel, line: first.line, portabilityReason: reason },
        ),
      );
    }
  }
  return out;
}

/** Disabling a core-by-reference skill is blocking. */
export function coreDisableGuard(name: string, entry: CatalogEntryView): SkillConflictFinding | null {
  if (!entry.core) return null;
  return finding(
    'core-disable',
    'blocking',
    'a registered workflow dispatches phases to this skill by name (`skill_ref`), directly or through a skill it mandates; disabling it would publish a snapshot those phases cannot run from',
    `${name} is core-by-reference`,
    { skill: name, against: { name, core: true } },
  );
}

/** Reset needs a baseline; a user-added skill has none. */
export function noBaselineGuard(name: string, userAdded: boolean): SkillConflictFinding | null {
  if (!userAdded) return null;
  return finding(
    'no-baseline',
    'blocking',
    'reset restores a skill from its shipped baseline; a user-added skill has none',
    `${name} is user-added`,
    { skill: name },
  );
}
