/**
 * crew#1703 (DES-artifact-editor-plugins §3.2 "Add these"): the skills and blocks a pack ships with its editors.
 *
 * One consent: the person approves the pack's skill directories and block ids exactly as the refusal listed them,
 * together with the editors' permissions. Everything is read and checked BEFORE the conformance run and before any
 * write, so a refusal installs nothing:
 *  - each skill goes to the daemon skills root (the one every worker is handed, as a published snapshot) under the
 *    key `wicked-garden-<skill dir>`, its frontmatter `name:` line rewritten to that key and nothing else (coord ruling
 *    (a), 2026-11-24): a worker invokes it as `wicked-garden:<skill dir>`;
 *  - each block's preset (`{id, label, phases}`) becomes a preset named by the block id whose steps are its phases,
 *    and every phase must be a catalog phase (ruling (b)): otherwise the block is refused naming the phase and the
 *    catalog phases it could use;
 *  - a skill key or preset name someone else holds (the operator, another pack, a built-in) is a 409. A pack
 *    installed again updates its own skills and presets in place.
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import type { InstalledPackSkill, Preset, PresetStep, SkillMutationResult, SkillPublishResult } from '../core/types.js';
import { SKILL_NAME_RE } from '../skills/guards.js';
import { SKILL_NAME_PREFIX } from '../skills/frontmatter.js';
import { FENCED_WORKFLOWS } from '../mcp/run-fence.js';
import type { SkillsRuntime } from '../skills/runtime.js';
import type { SkillsStore } from '../skills/store.js';

/** What the person approved: the pack's skill directories and block ids. */
export interface PackApproval {
  skills: string[];
  blocks: string[];
}

/** The daemon skills root, and how to publish it so workers get what was added. */
export interface PackSkillsPort {
  store: Pick<SkillsStore, 'manifest' | 'revision' | 'add' | 'replace' | 'disable'>;
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
  /** The pack installed it before: an update replaces it in place. */
  own: boolean;
}

export interface BlockPlan {
  id: string;
  steps: PresetStep[];
  own: boolean;
}

export interface ExtrasPlan {
  skills: SkillPlan[];
  blocks: BlockPlan[];
}

/** Bounds on what one pack skill may bring (files, bytes). */
export const PACK_SKILL_MAX_FILES = 200;
export const PACK_SKILL_MAX_BYTES = 2 * 1024 * 1024;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

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

/** Rewrite the frontmatter `name:` line to `key`; nothing else changes. A frontmatter without one gets it added. */
export function withInstalledName(text: string, key: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (m === null) throw new PackExtrasRefusal(422, 'pack_skill_unreadable', 'its SKILL.md has no frontmatter (a `---` block with a name and a description)');
  const head = m[1] ?? '';
  const start = m.index + text.slice(m.index).indexOf(head);
  const nameLine = /^name:[^\r\n]*$/m.exec(head);
  const next = nameLine === null ? `name: ${key}\n${head}` : `${head.slice(0, nameLine.index)}name: ${key}${head.slice(nameLine.index + nameLine[0].length)}`;
  return text.slice(0, start) + next + text.slice(start + head.length);
}

/** Every regular file under `dir` (no links, no escape), as UTF-8 text keyed by its path relative to `dir`. */
function readSkillFiles(dir: string, label: string): Record<string, string> {
  const files: Record<string, string> = {};
  let bytes = 0;
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(at, entry.name);
      const st = lstatSync(abs);
      const rel = relative(dir, abs).split(sep).join('/');
      if (st.isSymbolicLink()) throw new PackExtrasRefusal(422, 'pack_skill_unreadable', `the skill ${label} holds a link (${rel}); a pack skill brings plain files only`);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) throw new PackExtrasRefusal(422, 'pack_skill_unreadable', `the skill ${label} holds ${rel}, which is not a plain file`);
      bytes += st.size;
      if (Object.keys(files).length >= PACK_SKILL_MAX_FILES || bytes > PACK_SKILL_MAX_BYTES) {
        throw new PackExtrasRefusal(422, 'pack_skill_unreadable', `the skill ${label} is over ${PACK_SKILL_MAX_FILES} files or ${PACK_SKILL_MAX_BYTES / 1048576} MiB`);
      }
      const buf = readFileSync(abs);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      try {
        files[rel] = text.decode(buf);
      } catch {
        throw new PackExtrasRefusal(422, 'pack_skill_unreadable', `the skill ${label} holds ${rel}, which is not UTF-8 text`);
      }
    }
  };
  walk(dir);
  return files;
}

/** `rel` resolved under `root`, or null when it leaves it. */
function inside(root: string, rel: string): string | null {
  if (rel === '' || rel.startsWith('/') || rel.includes('\\')) return null;
  const abs = resolve(root, rel);
  return abs.startsWith(root + sep) ? abs : null;
}

/**
 * Read and check everything the pack's skills and blocks need, before anything runs or is written.
 * `owned` = the skill keys and preset names an earlier install of this same pack recorded.
 */
export async function planExtras(input: {
  root: string;
  manifest: Record<string, unknown>;
  skills: readonly string[];
  blocks: ReadonlyArray<Record<string, unknown>>;
  skillsPort: PackSkillsPort | null;
  presetsPort: PackPresetsPort | null;
  owned: { skills: ReadonlySet<string>; presets: ReadonlySet<string> };
}): Promise<ExtrasPlan> {
  const skillsDir = typeof input.manifest['skills_dir'] === 'string' ? input.manifest['skills_dir'] : 'skills';
  const skills: SkillPlan[] = [];
  if (input.skills.length > 0) {
    if (input.skillsPort === null) {
      throw new PackExtrasRefusal(422, 'pack_skills_unavailable', 'this daemon has no skills root, so it cannot add the pack’s skills; nothing was installed');
    }
    await input.skillsPort.ready?.();
    const held = input.skillsPort.store.manifest().skills;
    for (const dir of input.skills) {
      if (!SKILL_NAME_RE.test(dir)) throw new PackExtrasRefusal(422, 'pack_skill_unreadable', `the skill directory ${JSON.stringify(dir)} is not a valid skill name (letters, digits, - and _ only)`);
      const key = installedKey(dir);
      const own = input.owned.skills.has(key);
      if (Object.hasOwn(held, key) && !own) {
        throw new PackExtrasRefusal(409, 'pack_name_taken', `the skill ${dir} would be installed as ${key}, and the skills root already holds a skill of that name that this pack did not add; nothing was installed`);
      }
      const base = inside(input.root, `${skillsDir}/${dir}`);
      if (base === null) throw new PackExtrasRefusal(422, 'pack_skill_unreadable', `the skill ${dir} is outside the pack`);
      const files = readSkillFiles(base, dir);
      const md = files['SKILL.md'];
      if (md === undefined) throw new PackExtrasRefusal(422, 'pack_skill_unreadable', `the skill ${dir} has no SKILL.md`);
      try {
        files['SKILL.md'] = withInstalledName(md, key);
      } catch (err) {
        throw err instanceof PackExtrasRefusal ? new PackExtrasRefusal(err.status, err.code, `the skill ${dir}: ${err.message}`) : err;
      }
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
    const existing = new Set((await input.presetsPort.listPresets()).map((p) => p.name));
    for (const b of input.blocks) {
      const id = str(b['id']);
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new PackExtrasRefusal(422, 'pack_block_unmappable', `the block ${JSON.stringify(id)} has no usable id (lower-case letters, digits and -)`);
      const own = input.owned.presets.has(id);
      if (FENCED_WORKFLOWS.has(id) || (existing.has(id) && !own)) {
        throw new PackExtrasRefusal(409, 'pack_name_taken', `the block ${id} would be saved as the preset ${id}, and a preset of that name already exists that this pack did not add; nothing was installed`);
      }
      const at = inside(input.root, str(b['preset']));
      let raw: unknown = null;
      try {
        if (at === null || !lstatSync(at).isFile()) throw new Error('missing');
        raw = JSON.parse(readFileSync(at, 'utf8'));
      } catch {
        throw new PackExtrasRefusal(422, 'pack_block_unmappable', `the block ${id}: its preset ${JSON.stringify(str(b['preset']))} is not a JSON file inside the pack`);
      }
      const list = (raw as { phases?: unknown } | null)?.phases;
      if (!Array.isArray(list) || list.length === 0 || !list.every((p): p is string => typeof p === 'string')) {
        throw new PackExtrasRefusal(422, 'pack_block_unmappable', `the block ${id}: its preset lists no phases`);
      }
      const unknown = list.filter((p) => !catalog.has(p));
      if (unknown.length > 0) {
        throw new PackExtrasRefusal(
          422,
          'pack_block_unmappable',
          `the block ${id} names ${unknown.map((p) => `\`${p}\``).join(', ')}, which ${unknown.length === 1 ? 'is not a catalog phase' : 'are not catalog phases'}; a block's phases must be catalog phases (${phases.join(', ')}). Nothing was installed`,
        );
      }
      blocks.push({ id, steps: list.map((p) => ({ catalog: p, id: p })), own });
    }
  }
  return { skills, blocks };
}

/** What {@link applyExtras} wrote, so a later failure can take it back. */
export interface AppliedExtras {
  undo(): Promise<void>;
}

/** Write the plan: the skills into the skills root (not yet published), then the presets. A refused write undoes the rest. */
export async function applyExtras(plan: ExtrasPlan, ports: { skills: PackSkillsPort | null; presets: PackPresetsPort | null }, packName: string): Promise<AppliedExtras> {
  const added: string[] = [];
  const presetsWritten: string[] = [];
  const undo = async (): Promise<void> => {
    for (const name of presetsWritten) await ports.presets?.deletePreset(name).catch(() => false);
    for (const key of added) {
      try {
        ports.skills?.store.disable(key, ports.skills.store.revision());
      } catch {
        // a skill that cannot be switched off stays unpublished: nothing hands it to a worker until a publish
      }
    }
  };
  try {
    for (const s of plan.skills) {
      const store = ports.skills!.store;
      const result: SkillMutationResult = s.own ? store.replace(s.key, s.files, store.revision()) : store.add(s.key, s.files, store.revision());
      if (result.verdict === 'blocked') {
        const why = result.findings.filter((f) => f.severity === 'blocking').map((f) => f.evidence).join('; ');
        throw new PackExtrasRefusal(422, 'pack_skill_refused', `the skills root refused the skill ${s.name} (${s.key}): ${why}; nothing was installed`);
      }
      if (!s.own) added.push(s.key);
    }
    for (const b of plan.blocks) {
      await ports.presets!.putPreset(b.id, b.steps, undefined, `pack:${packName}`);
      if (!b.own) presetsWritten.push(b.id);
    }
  } catch (err) {
    await undo();
    throw err;
  }
  return { undo };
}
