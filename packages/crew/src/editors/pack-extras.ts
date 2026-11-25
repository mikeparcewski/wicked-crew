/**
 * crew#1703 (DES-artifact-editor-plugins §3.2 "Add these"): the skills and blocks a pack ships with its editors.
 *
 * One consent: the person approves the pack's skill directories and block ids exactly as the refusal listed them,
 * together with its editors' permissions and its run plugins' topics, and the approval carries the refusal's
 * `digest`, which covers the manifest, every skill file and every block's steps, so a pack that changed after the
 * person looked is refused. Everything is read and checked before the conformance run and before any write:
 *  - each skill goes to the daemon skills root (the one every worker is handed, as a published snapshot) under the
 *    key `wicked-garden-<skill dir>`, its frontmatter `name:` line rewritten to that key and nothing else (coord ruling
 *    (a), 2026-11-24): a worker invokes it as `wicked-garden:<skill dir>`. The store's own add/replace guards run on
 *    it first (`SkillsStore.previewWrite`);
 *  - each block's preset (`{id, label, phases}`) becomes a preset named by the block id with one step per phase, and
 *    every phase must be a catalog phase (ruling (b)): otherwise the block is refused naming the phase and the catalog
 *    phases it could use;
 *  - a skill key or preset name that is not this pack's own is a 409. A pack is known by its name, as the editor
 *    registry knows it (`EditorRegistry.installPack`): installing a pack of the same name again replaces its own
 *    skills and presets, and the consent lists them (`replaces`) so the person sees what is replaced.
 * Reads stay inside the pack: no link in any path component, leaves opened no-follow, bounded files, entries and bytes.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { InstalledPackSkill, Preset, PresetStep, SkillConflictFinding, SkillPublishResult } from '../core/types.js';
import { SKILL_NAME_RE } from '../skills/guards.js';
import { SKILL_NAME_PREFIX } from '../skills/frontmatter.js';
import { budgetPacer } from '../skills/tree.js';
import { FENCED_WORKFLOWS } from '../mcp/run-fence.js';
import type { SkillsRuntime } from '../skills/runtime.js';
import type { SkillsStore } from '../skills/store.js';

/** What the person approved: the pack's skill directories and block ids, and the digest the refusal showed. */
export interface PackApproval {
  skills: string[];
  blocks: string[];
  digest?: string | undefined;
}

/** The daemon skills root, and how to publish it so workers get what was added. */
export interface PackSkillsPort {
  store: Pick<SkillsStore, 'manifest' | 'revision' | 'add' | 'replace' | 'enable' | 'disable' | 'previewWrite' | 'isPublishing' | 'listFiles' | 'resolveSkillFile' | 'currentSnapshotPaced' | 'snapshotSkillsOf'>;
  publish(): Promise<Pick<SkillPublishResult, 'verdict' | 'findings' | 'snapshot'>>;
  /** Settles once the daemon's skills boot (seed, first publish) has landed; every skills write waits for it. */
  ready?(): Promise<void>;
}

/** The daemon's skills runtime as a port: publish exactly as `POST /skills/publish` does (the export runs inside the
 *  store's in-flight window), and wait for the boot ladder first, as every `/skills` request does. */
export function packSkillsPort(runtime: SkillsRuntime): PackSkillsPort {
  return {
    store: runtime.store,
    ready: () => runtime.bootSettled(),
    publish: async () => {
      await runtime.bootSettled();
      return runtime.store.publish(runtime.store.revision(), async (result, pacer) => {
        if (result.snapshot !== null && result.unchanged !== true) {
          runtime.notePublished(result);
          await runtime.afterPublishPaced(pacer);
        }
      });
    },
  };
}

/** The engine's preset store and phase catalog (the adapter). */
export interface PackPresetsPort {
  catalogIds(): Promise<ReadonlySet<string> | null>;
  listPresets(): Promise<Preset[]>;
  putPreset(name: string, steps: PresetStep[], projectId?: string, createdBy?: string): Promise<Preset>;
  deletePreset(name: string): Promise<boolean>;
  /** The registered workflow definitions (built-in and system): a block may not take one's name. */
  listWorkflows?(): ReadonlyArray<{ id: string }>;
}

/** A refusal: the HTTP status, the code, and the plain reason. */
export class PackExtrasRefusal extends Error {
  constructor(
    readonly status: 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PackExtrasRefusal';
  }
}

export interface SkillPlan extends InstalledPackSkill {
  files: Record<string, string>;
  /** This pack installed it before: an update replaces it in place. */
  own: boolean;
}

export interface BlockPlan {
  id: string;
  steps: PresetStep[];
  /** The preset this pack wrote before, now replaced (restored if the install fails after the write). */
  previous: Preset | null;
}

export interface ExtrasPlan {
  skills: SkillPlan[];
  blocks: BlockPlan[];
  /** The skill keys and preset names this install replaces (this pack's own, from an earlier install). */
  replaces: string[];
  /** sha256 over the manifest, every skill file and every block's steps: what the person approves. */
  digest: string;
}

/** Bounds on what a pack may bring. */
export const PACK_EXTRAS_MAX = 200;
export const PACK_SKILL_MAX_FILES = 200;
export const PACK_SKILL_MAX_ENTRIES = 1000;
export const PACK_SKILL_MAX_DEPTH = 16;
export const PACK_SKILL_MAX_BYTES = 2 * 1024 * 1024;
export const PACK_PRESET_MAX_BYTES = 64 * 1024;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const unreadable = (msg: string): PackExtrasRefusal => new PackExtrasRefusal(422, 'pack_skill_unreadable', msg);

/** The key a pack skill directory is installed under. */
export function installedKey(dir: string): string {
  return `${SKILL_NAME_PREFIX}${dir}`;
}

/** The pack's skills with their installed keys, in the pack's order. */
export function installedSkillsOf(skills: readonly string[]): InstalledPackSkill[] {
  return skills.map((name) => ({ name, key: installedKey(name) }));
}

/** Does `approve` name exactly these skills and blocks? Returns what differs, empty when it does. */
export function approvalDiff(approve: PackApproval, skills: readonly string[], blocks: readonly string[]): string[] {
  const diff = (kind: string, want: readonly string[], got: readonly string[]): string[] => {
    const w = new Set(want);
    const g = new Set(got);
    return [
      ...[...w].filter((x) => !g.has(x)).map((x) => `the ${kind} ${x} is not approved`),
      ...[...g].filter((x) => !w.has(x)).map((x) => `${x} is not a ${kind} of this pack`),
    ];
  };
  return [...diff('skill', skills, approve.skills), ...diff('block', blocks, approve.blocks)];
}

/**
 * Rewrite the frontmatter's top-level `name` key to `key`; nothing else changes. The key may carry spaces before its
 * colon (`name : x` is the same YAML key). A frontmatter without one gets it added as its first line.
 */
export function withInstalledName(text: string, key: string): string {
  const open = /^---(\r?\n)/.exec(text);
  if (open === null) throw unreadable('its SKILL.md has no frontmatter (a `---` block with a name and a description)');
  const eol = open[1] ?? '\n';
  const bodyStart = open[0].length;
  const close = /(^|\r?\n)---(?:\r?\n|$)/.exec(text.slice(bodyStart));
  if (close === null) throw unreadable('its SKILL.md frontmatter is not closed (no second `---` line)');
  const head = text.slice(bodyStart, bodyStart + close.index);
  const nameLine = /^name[ \t]*:[^\r\n]*$/m.exec(head);
  const next =
    nameLine === null
      ? `name: ${key}${head === '' ? '' : eol}${head}`
      : `${head.slice(0, nameLine.index)}name: ${key}${head.slice(nameLine.index + nameLine[0].length)}`;
  return text.slice(0, bodyStart) + next + text.slice(bodyStart + head.length);
}

/** `rel` (forward slashes) under `root`, every component a real directory or (the last) a real file: no link, no `..`. */
function containedPath(root: string, rel: string, leaf: 'dir' | 'file'): string | null {
  if (rel === '' || rel.startsWith('/') || rel.includes('\\')) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  let at = root;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return null;
    }
    const last = i === parts.length - 1;
    if (st.isSymbolicLink()) return null;
    if (!last && !st.isDirectory()) return null;
    if (last && (leaf === 'dir' ? !st.isDirectory() : !st.isFile())) return null;
  }
  return at;
}

/** A regular file read through a no-follow descriptor, at most `max` bytes (null when larger or not a plain file). */
function readNoFollowCapped(path: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return off === st.size ? buf : null;
  } finally {
    closeSync(fd);
  }
}

/** Every regular file under `dir` (no links, bounded), as UTF-8 text keyed by its path relative to `dir`. */
function readSkillFiles(dir: string, label: string): Record<string, string> {
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  let count = 0;
  let entries = 0;
  let bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const walk = (at: string, rel: string, depth: number): void => {
    if (depth > PACK_SKILL_MAX_DEPTH) throw unreadable(`the skill ${label} nests deeper than ${PACK_SKILL_MAX_DEPTH} folders`);
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > PACK_SKILL_MAX_ENTRIES) throw unreadable(`the skill ${label} holds over ${PACK_SKILL_MAX_ENTRIES} files and folders`);
      const abs = join(at, entry.name);
      const r = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw unreadable(`the skill ${label} holds a link (${r}); a pack skill brings plain files only`);
      if (st.isDirectory()) {
        walk(abs, r, depth + 1);
        continue;
      }
      if (!st.isFile()) throw unreadable(`the skill ${label} holds ${r}, which is not a plain file`);
      if (++count > PACK_SKILL_MAX_FILES) throw unreadable(`the skill ${label} holds over ${PACK_SKILL_MAX_FILES} files`);
      const buf = readNoFollowCapped(abs, PACK_SKILL_MAX_BYTES - bytes);
      if (buf === null) throw unreadable(`the skill ${label} is over ${PACK_SKILL_MAX_BYTES / 1048576} MiB, or ${r} could not be read as a plain file`);
      bytes += buf.length;
      try {
        files[r] = decoder.decode(buf);
      } catch {
        throw unreadable(`the skill ${label} holds ${r}, which is not UTF-8 text`);
      }
    }
  };
  walk(dir, '', 0);
  return files;
}

/** One step per phase; a phase named again gets its own step id (`review`, `review-2`, …). */
function stepsOf(phases: readonly string[]): PresetStep[] {
  const seen = new Map<string, number>();
  return phases.map((p) => {
    const n = (seen.get(p) ?? 0) + 1;
    seen.set(p, n);
    return { catalog: p, id: n === 1 ? p : `${p}-${n}` };
  });
}

/** The preset owner stamp a pack's block presets carry (`created_by`). */
/** The origin a pack's skills carry in the skills root (`SkillEntry.origin`): they are the pack's, not an operator
 *  change, so the daemon's garden auto-refresh keeps running. */
export function packSkillOrigin(packName: string): string {
  return `pack:${packName}`;
}

export function packPresetOwner(packName: string): string {
  return `pack:${packName}`;
}

/**
 * Read and check everything the pack's skills and blocks need, before anything runs or is written.
 * `owned` = the skill keys and preset names an earlier install of this same pack recorded.
 */
export async function planExtras(input: {
  root: string;
  manifestText: string;
  manifest: Record<string, unknown>;
  packName: string;
  skills: readonly string[];
  blocks: ReadonlyArray<Record<string, unknown>>;
  skillsPort: PackSkillsPort | null;
  presetsPort: PackPresetsPort | null;
  owned: { skills: ReadonlySet<string>; presets: ReadonlySet<string> };
}): Promise<ExtrasPlan> {
  if (input.skills.length > PACK_EXTRAS_MAX || input.blocks.length > PACK_EXTRAS_MAX) {
    throw new PackExtrasRefusal(422, 'pack_too_large', `the pack brings over ${PACK_EXTRAS_MAX} skills or blocks; nothing was installed`);
  }
  const skillsDir = typeof input.manifest['skills_dir'] === 'string' ? input.manifest['skills_dir'] : 'skills';
  const skills: SkillPlan[] = [];
  const replaces: string[] = [];
  if (input.skills.length > 0) {
    if (input.skillsPort === null) {
      throw new PackExtrasRefusal(422, 'pack_skills_unavailable', 'this daemon has no skills root, so it cannot add the pack’s skills; nothing was installed');
    }
    await input.skillsPort.ready?.();
    const held = input.skillsPort.store.manifest().skills;
    for (const dir of input.skills) {
      if (!SKILL_NAME_RE.test(dir)) throw unreadable(`the skill directory ${JSON.stringify(dir)} is not a valid skill name (letters, digits, - and _ only)`);
      const key = installedKey(dir);
      const exists = Object.hasOwn(held, key);
      // The pack's own: the record names it, or it carries this pack's stamp (crew#1915). Only this pack's install writes
      // `origin: pack:<name>`, so a skill written before a restart or a failed record write is still the pack's.
      const own = exists && (input.owned.skills.has(key) || held[key]?.origin === packSkillOrigin(input.packName));
      if (exists && !own) {
        throw new PackExtrasRefusal(409, 'pack_name_taken', `the skill ${dir} would be installed as ${key}, and the skills root already holds a skill of that name that this pack did not add; nothing was installed`);
      }
      const base = containedPath(input.root, `${skillsDir}/${dir}`, 'dir');
      if (base === null) throw unreadable(`the skill ${dir} is not a folder inside the pack (a missing folder, or a link)`);
      const files = readSkillFiles(base, dir);
      const md = files['SKILL.md'];
      if (md === undefined) throw unreadable(`the skill ${dir} has no SKILL.md`);
      try {
        files['SKILL.md'] = withInstalledName(md, key);
      } catch (err) {
        throw err instanceof PackExtrasRefusal ? unreadable(`the skill ${dir}: ${err.message}`) : err;
      }
      const blocking: SkillConflictFinding[] = input.skillsPort.store.previewWrite(key, files);
      if (blocking.length > 0) {
        throw new PackExtrasRefusal(422, 'pack_skill_refused', `the skills root would refuse the skill ${dir} (${key}): ${blocking.map((f) => f.evidence).join('; ')}; nothing was installed`);
      }
      if (own) replaces.push(key);
      skills.push({ name: dir, key, files, own });
    }
  }
  const blocks: BlockPlan[] = [];
  if (input.blocks.length > 0) {
    if (input.presetsPort === null) {
      throw new PackExtrasRefusal(422, 'pack_blocks_unavailable', 'this daemon has no preset store, so it cannot add the pack’s blocks; nothing was installed');
    }
    const catalog = await input.presetsPort.catalogIds();
    if (catalog === null) throw new PackExtrasRefusal(422, 'pack_blocks_unavailable', 'the engine’s phase catalog could not be read, so the pack’s blocks cannot be checked; nothing was installed');
    const phases = [...catalog].sort();
    const existing = new Map((await input.presetsPort.listPresets()).map((p) => [p.name, p]));
    const workflows = new Set((input.presetsPort.listWorkflows?.() ?? []).map((w) => w.id));
    for (const b of input.blocks) {
      const id = str(b['id']);
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new PackExtrasRefusal(422, 'pack_block_unmappable', `the block ${JSON.stringify(id)} has no usable id (lower-case letters, digits and -)`);
      // Its own preset only while the row carries this pack's stamp (`pack:<name>`, written by nothing else): a preset
      // someone else saved under the name since is theirs, whatever an older install record says.
      const row = existing.get(id);
      const own = row !== undefined && row.created_by === packPresetOwner(input.packName);
      if (FENCED_WORKFLOWS.has(id) || (row !== undefined && !own)) {
        throw new PackExtrasRefusal(409, 'pack_name_taken', `the block ${id} would be saved as the preset ${id}, and a preset of that name already exists that this pack did not add; nothing was installed`);
      }
      // A preset of a workflow's name would be launched in its place (an owned one too: the workflow may be newer).
      if (workflows.has(id)) {
        throw new PackExtrasRefusal(409, 'pack_name_taken', `the block ${id} would be saved as the preset ${id}, which is the name of a registered workflow; nothing was installed`);
      }
      const at = containedPath(input.root, str(b['preset']), 'file');
      const buf = at === null ? null : readNoFollowCapped(at, PACK_PRESET_MAX_BYTES);
      let raw: unknown = null;
      try {
        if (buf === null) throw new Error('unreadable');
        raw = JSON.parse(buf.toString('utf8'));
      } catch {
        throw new PackExtrasRefusal(422, 'pack_block_unmappable', `the block ${id}: its preset ${JSON.stringify(str(b['preset']))} is not a JSON file inside the pack (at most ${PACK_PRESET_MAX_BYTES / 1024} KiB)`);
      }
      const list = (raw as { phases?: unknown } | null)?.phases;
      if (!Array.isArray(list) || list.length === 0 || list.length > 64 || !list.every((p): p is string => typeof p === 'string')) {
        throw new PackExtrasRefusal(422, 'pack_block_unmappable', `the block ${id}: its preset lists no phases (or over 64)`);
      }
      const unknown = [...new Set(list.filter((p) => !catalog.has(p)))];
      if (unknown.length > 0) {
        throw new PackExtrasRefusal(
          422,
          'pack_block_unmappable',
          `the block ${id} names ${unknown.map((p) => `\`${p}\``).join(', ')}, which ${unknown.length === 1 ? 'is not a catalog phase' : 'are not catalog phases'}; a block's phases must be catalog phases (${phases.join(', ')}). Nothing was installed`,
        );
      }
      if (own) replaces.push(id);
      blocks.push({ id, steps: stepsOf(list), previous: own ? row : null });
    }
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        manifest: input.manifestText,
        skills: skills.map((s) => ({ key: s.key, files: Object.keys(s.files).sort().map((f) => [f, s.files[f]]) })),
        blocks: blocks.map((b) => ({ id: b.id, steps: b.steps })),
      }),
    )
    .digest('hex');
  return { skills, blocks, replaces, digest };
}

/** Write the block presets (before the registry commits). Returns how to put back what was there: `undo` answers
 *  what it could not put back (empty when everything was). */
export async function writePresets(plan: ExtrasPlan, presets: PackPresetsPort | null, packName: string): Promise<{ undo(): Promise<string[]> }> {
  const written: BlockPlan[] = [];
  const undo = async (): Promise<string[]> => {
    const failed: string[] = [];
    for (const b of written.reverse()) {
      try {
        if (b.previous !== null) await presets?.putPreset(b.id, b.previous.steps, undefined, b.previous.created_by);
        else await presets?.deletePreset(b.id);
      } catch (err) {
        failed.push(`${b.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return failed;
  };
  if (plan.blocks.length === 0) return { undo };
  // Re-read just before writing: a preset someone saved under the name during the conformance run is theirs.
  const now = new Map((await presets!.listPresets()).map((p) => [p.name, p]));
  try {
    for (const b of plan.blocks) {
      const row = now.get(b.id);
      if (row !== undefined && (b.previous === null || row.created_by !== packPresetOwner(packName))) {
        throw new PackExtrasRefusal(409, 'pack_name_taken', `the preset ${b.id} was saved by someone else while the pack was being checked; nothing was installed`);
      }
      await presets!.putPreset(b.id, b.steps, undefined, packPresetOwner(packName));
      written.push(b);
    }
  } catch (err) {
    const left = await undo();
    if (left.length > 0 && err instanceof Error) err.message = `${err.message} (putting the presets back also failed: ${left.join('; ')}; installing the pack again replaces them)`;
    throw err;
  }
  return { undo };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A skill's files and switch as they are now, to put back if the pass fails. `null` when they cannot be kept whole:
 *  a file that does not read, or one that is not UTF-8 text (the store writes text, so it could not be put back). */
function preImage(store: PackSkillsPort['store'], key: string): { files: Record<string, string>; enabled: boolean } | null {
  try {
    const tree = store.listFiles(key);
    const files: Record<string, string> = Object.create(null) as Record<string, string>;
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    for (const f of tree.files) files[f.path] = utf8.decode(readFileSync(store.resolveSkillFile(key, f.path).abs));
    return { files, enabled: tree.enabled };
  } catch {
    return null;
  }
}

/**
 * Write the pack's skills into the skills root (after the registry committed), then publish so workers get them.
 * The writes run in one synchronous pass once no publish is in flight, so no publish can capture half of them. The
 * person approved the pack's skills, so each one is switched on. If a write fails (the store changed since the plan)
 * or the publish is blocked, the pass is put back: each replaced skill gets its earlier files and switch, and each
 * added one is switched off. Answers `null`, or the reason workers do not have the skills yet (the install stands).
 */
export async function writeSkills(plan: ExtrasPlan, port: PackSkillsPort | null, opts: { waitMs?: number; origin?: string } = {}): Promise<string | null> {
  if (plan.skills.length === 0 || port === null) return null;
  const store = port.store;
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  while (store.isPublishing()) {
    if (Date.now() > deadline) return 'installed, but the skills root was busy publishing, so the pack’s skills were not added; install the pack again';
    await sleep(100);
  }
  // A copy of every skill this pass replaces, taken before the first write: without a whole copy, nothing is written.
  const replaced: Array<{ key: string; before: { files: Record<string, string>; enabled: boolean } }> = [];
  for (const s of plan.skills.filter((x) => x.own)) {
    const before = preImage(store, s.key);
    if (before === null) return `installed, but the skill ${s.key} could not be copied whole before it was replaced (a file that does not read, or is not text), so the pack’s skills were not changed`;
    replaced.push({ key: s.key, before });
  }
  const added: string[] = [];
  const done = new Set<string>();
  const blocked = (r: { verdict?: string }): boolean => r.verdict === 'blocked';
  const putBack = (): string[] => {
    const left: string[] = [];
    for (const key of added) {
      try {
        if (store.manifest().skills[key]?.enabled === true && blocked(store.disable(key, store.revision()))) left.push(key);
      } catch {
        left.push(key);
      }
    }
    for (const { key, before } of [...replaced].reverse()) {
      if (!done.has(key)) continue;
      try {
        if (blocked(store.replace(key, before.files, store.revision()))) {
          left.push(key);
          continue;
        }
        const on = store.manifest().skills[key]?.enabled === true;
        if (on !== before.enabled && blocked((before.enabled ? store.enable : store.disable).call(store, key, store.revision()))) left.push(key);
      } catch {
        left.push(key);
      }
    }
    return left;
  };
  const leftNote = (left: string[]): string => (left.length > 0 ? ` (could not put back ${left.join(', ')}; install the pack again)` : '');
  for (const s of plan.skills) {
    let why: string | null = null;
    try {
      // Marked before the call: a write that fails partway may have changed the skill, and its copy is put back.
      if (s.own) done.add(s.key);
      const r = s.own ? store.replace(s.key, s.files, store.revision()) : store.add(s.key, s.files, store.revision(), opts.origin !== undefined ? { origin: opts.origin } : {});
      if (r.verdict === 'blocked') why = r.findings.filter((f) => f.severity === 'blocking').map((f) => f.evidence).join('; ');
      else {
        if (!s.own) added.push(s.key);
        if (store.manifest().skills[s.key]?.enabled === false) store.enable(s.key, store.revision());
      }
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    if (why !== null) {
      const left = putBack();
      return `installed, but the skills root refused the skill ${s.name} (${s.key}): ${why}; workers do not get the pack’s skills${leftNote(left)}`;
    }
  }
  try {
    const published = await port.publish();
    if (published.verdict === 'blocked') {
      // The pass leaves the tree again so the next publish is not blocked by it.
      const left = putBack();
      const why = published.findings.filter((f) => f.severity === 'blocking').map((f) => f.evidence).join('; ');
      return `installed, but the skills root could not be published (${why}), so workers do not get the pack’s skills; fix that and install the pack again${leftNote(left)}`;
    }
  } catch (err) {
    return `installed, but the skills root could not be published (${err instanceof Error ? err.message : String(err)}), so workers do not get the pack’s skills yet; publish from Skills`;
  }
  return null;
}

/** What a withdrawal switched off and deleted, and what it could not do. */
export interface PackWithdrawal {
  /** Pack skills switched off (they stay in the skills root, out of every published generation). */
  skills: string[];
  /** Presets deleted (only those still carrying the pack's stamp). */
  presets: string[];
  error?: string;
}

/**
 * Withdraw what a pack added (crew#1703, coord round 2 F1): when its last editor is removed, or an update no longer
 * ships a skill or block. The skills root has no removal, so each skill is switched off and the root published, so
 * workers stop getting it; a preset is deleted while it still carries the pack's stamp (one someone else saved
 * since is theirs). The pack keeps them as its own, so installing it again brings them back.
 */
export async function withdrawPackExtras(input: {
  packName: string;
  skills: readonly string[];
  presets: readonly string[];
  skillsPort: PackSkillsPort | null;
  presetsPort: PackPresetsPort | null;
  waitMs?: number;
  /** The pack's last editor is going: every skill stamped as the pack's leaves too, named by the record or not. */
  wholePack?: boolean;
}): Promise<PackWithdrawal> {
  const out: PackWithdrawal = { skills: [], presets: [] };
  const problems: string[] = [];
  if (input.presets.length > 0 && input.presetsPort !== null) {
    try {
      const rows = new Map((await input.presetsPort.listPresets()).map((p) => [p.name, p]));
      for (const id of input.presets) {
        if (rows.get(id)?.created_by !== packPresetOwner(input.packName)) continue;
        try {
          if (await input.presetsPort.deletePreset(id)) out.presets.push(id);
        } catch (err) {
          problems.push(`the preset ${id} could not be deleted (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    } catch (err) {
      problems.push(`the presets could not be read (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (input.skillsPort !== null) {
    const port = input.skillsPort;
    try {
      // The whole pack going: the record's skills and any carrying this pack's stamp that the record never came to name
      // (a failed record write, or a restart between the publish and the record: crew#1917 r1).
      const origin = packSkillOrigin(input.packName);
      const held = port.store.manifest().skills;
      const keys = input.wholePack === true ? [...new Set([...input.skills, ...Object.keys(held).filter((k) => held[k]?.origin === origin)])] : [...input.skills];
      if (keys.length > 0) await port.ready?.();
      const deadline = Date.now() + (input.waitMs ?? 30_000);
      while (keys.length > 0 && port.store.isPublishing()) {
        if (Date.now() > deadline) throw new Error('the skills root was busy publishing');
        await sleep(100);
      }
      for (const key of keys) {
        // Only one still marked as this pack's: a skill the operator took over (or never the pack's) stays.
        const entry = port.store.manifest().skills[key];
        if (entry?.enabled !== true || entry.origin !== packSkillOrigin(input.packName)) continue;
        const r = port.store.disable(key, port.store.revision());
        if (r.verdict === 'blocked') problems.push(`the skill ${key} could not be switched off (${r.findings.filter((f) => f.severity === 'blocking').map((f) => f.evidence).join('; ')})`);
        else out.skills.push(key);
      }
      // Published when a switched-off pack skill is still in the generation workers get: one just switched off, or one an
      // earlier withdrawal switched off whose publish was blocked (a retry finishes it, crew#1916).
      // The generation is read (paced: a walk of it, crew#852) only when nothing was just switched off and a switched-off
      // one of the pack's could still be in it.
      let stale = false;
      const now = port.store.manifest().skills;
      const off = keys.filter((key) => now[key]?.origin === origin && now[key]?.enabled === false);
      if (out.skills.length === 0 && off.length > 0) {
        try {
          const current = await port.store.currentSnapshotPaced(budgetPacer());
          const live = new Set(current === null ? [] : (port.store.snapshotSkillsOf(current)?.skills ?? off));
          stale = off.some((key) => live.has(key));
        } catch {
          stale = true; // unreadable: publish to be sure
        }
      }
      if (out.skills.length > 0 || stale) {
        const published = await port.publish();
        if (published.verdict === 'blocked') {
          problems.push(`the skills root could not be published (${published.findings.filter((f) => f.severity === 'blocking').map((f) => f.evidence).join('; ')}), so workers keep the switched-off skills until the next publish`);
        }
      }
    } catch (err) {
      problems.push(`the pack’s skills could not be switched off (${err instanceof Error ? err.message : String(err)}); switch them off in Skills`);
    }
  }
  if (problems.length > 0) out.error = problems.join('; ');
  return out;
}
