/**
 * ADD A REPOSITORY FROM A CHAT (crew-0182, crew 0.18.2). A seat asked to onboard a git repository into a project ends its
 * reply with a `wicked-make` block `{"onboard":{"url":…,"project":…,"name":…}}`. Crew, never the seat, resolves it into
 * an `onboard` card (`resolveOnboard`): a git address it can clone, the project by id or by name (case- and
 * space-insensitive), the registry name, an already-registered copy of the same repository, and whether this computer's
 * git can read it at all (a private repository with no sign-in, a typo). The person's one Go (`OnboardLauncher`) then
 * takes the same path as `POST /repos {gitUrl, projectId}`: clone, register, onboard, and the repo joins the project
 * through the one attach path (`projects/routes.ts` `attachRepoToProject`). Not now changes nothing.
 */
import { z } from '../zod.js';
import { execCapped } from '../core/exec.js';
import type { Actor, ArtifactProposal, ProposalOnboard, RepoEntry } from '../core/types.js';
import type { ProposalDispatch, ProposalDispatcher } from './chat-proposals.js';
import { coreRepoSlug } from '../projects/repo-guard.js';

/** A registry name: what `POST /repos` accepts. */
export const SAFE_REPO_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const OnboardBlock = z.object({
  onboard: z.object({
    url: z.string().trim().min(1).max(2048),
    project: z.string().trim().max(200).nullable().optional(),
    name: z.string().trim().max(128).nullable().optional(),
  }),
  reason: z.string().max(600).optional(),
});
export type OnboardBlockBody = z.infer<typeof OnboardBlock>;

export type GitUrlReading = { ok: true; url: string; key: string; name: string } | { ok: false; reason: string };

// User and host start with a letter or digit (never `-`: an ssh option).
const SCP = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9.-]*):(?!\/)([A-Za-z0-9._~/-]+)$/;

/** Hosts whose repository paths are case-insensitive: only there do two spellings that differ in case name one repo. */
const CASELESS_HOSTS: ReadonlySet<string> = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

/**
 * An address as it may be shown or stored: any `user:password@` / `token@` removed (crew-0182 review: a rejected
 * address carrying a token was copied into the card, and a registered `origin` with one reached every chat's statement).
 */
export function withoutCredentials(raw: string): string {
  const t = raw.trim();
  try {
    const u = new URL(t);
    if (u.username === '' && u.password === '') return t;
    if (u.protocol === 'ssh:' && u.password === '' && u.username === 'git') return t;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    // Not a URL (an scp spelling keeps its `git@`; anything else loses whatever sits before an `@` in its authority).
    return SCP.test(t) ? t : t.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
  }
}

/**
 * A git address crew will clone: `https://host/owner/repo(.git)`, `ssh://[user@]host[:port]/path` or
 * `user@host:owner/repo(.git)`. Anything else (a local path, `file://`, `ext::`, plain `http://`, an address carrying a
 * password or token) is refused with its reason. `key` compares two spellings of one repository (host lowercased, a
 * non-`git` ssh user kept, no `.git` or trailing slash; the path case-insensitive only on GitHub, GitLab and Bitbucket);
 * `name` is its last path segment.
 */
export function readGitUrl(raw: string): GitUrlReading {
  const url = raw.trim();
  if (url === '' || /[\s\u0000-\u001f\u007f]/.test(url)) return { ok: false, reason: 'the address has spaces or control characters in it' };
  let host: string;
  let path: string;
  const scp = SCP.exec(url);
  if (scp !== null) {
    // An scp path is relative to that user's home: a user other than `git` is part of which repository it is.
    host = `${scp[1] !== 'git' ? `${scp[1]}@` : ''}${scp[2]!.toLowerCase()}`;
    path = scp[3]!;
  } else {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, reason: 'it is not a git address (use https://host/owner/repo or git@host:owner/repo)' };
    }
    if (u.protocol === 'http:') return { ok: false, reason: 'plain http is not used: give the https:// address' };
    if (u.protocol !== 'https:' && u.protocol !== 'ssh:') {
      return { ok: false, reason: `a ${u.protocol.replace(/:$/, '')} address can't be cloned from a chat (use https:// or ssh)` };
    }
    if (u.password !== '' || (u.protocol === 'https:' && u.username !== '')) {
      return { ok: false, reason: 'the address carries a user name or token; give it without one (git uses your own sign-in)' };
    }
    if (u.search !== '' || u.hash !== '') return { ok: false, reason: 'the address has a query or fragment; give the plain repository address' };
    host = `${u.username !== '' && u.username !== 'git' ? `${u.username}@` : ''}${u.hostname.toLowerCase()}${u.port !== '' ? `:${u.port}` : ''}`;
    try {
      path = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    } catch {
      return { ok: false, reason: 'the address has a broken %-escape in its path' };
    }
  }
  const segments = path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/');
  if (host === '' || segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return { ok: false, reason: 'the address names no repository path' };
  }
  const name = segments[segments.length - 1]!;
  const repoPath = segments.join('/');
  return { ok: true, url, key: `${host}/${CASELESS_HOSTS.has(host) ? repoPath.toLowerCase() : repoPath}`, name };
}

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The project the words name: by id, else by name ignoring case and spacing. */
export function matchProject<P extends { id: string; name: string }>(projects: readonly P[], words: string): { one: P } | { none: true } | { many: P[] } {
  const byId = projects.find((p) => p.id === words.trim());
  if (byId !== undefined) return { one: byId };
  const hits = projects.filter((p) => norm(p.name) === norm(words));
  if (hits.length === 1) return { one: hits[0]! };
  return hits.length === 0 ? { none: true } : { many: hits };
}

/** What a git read of the address said: `null` = readable. Plain words for the card, never git's raw output alone. */
export function probeVerdict(stderr: string): string {
  const s = stderr.toLowerCase();
  if (/could not read username|terminal prompts disabled|authentication failed|permission denied|403|401|could not read from remote repository|repository not found/.test(s)) {
    return "this computer's git can't read it: the repository is private or doesn't exist. If it is private, sign git in "
      + 'first (for GitHub, run `gh auth login`, or set up a git credential or SSH key), then ask again';
  }
  if (/could not resolve host|network is unreachable|timed out|connection refused/.test(s)) {
    return "this computer can't reach that host right now; check the address and the network, then ask again";
  }
  const line = stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? 'git could not read it';
  return `git could not read it (${line.slice(0, 200)})`;
}

/** Only the transports a chat may clone over, whatever `url.*.insteadOf` rewrites an address to (crew-0182 review). */
export const CHAT_GIT_PROTOCOLS = 'https:ssh';

/** `git ls-remote` with no prompt: `null` when the address is readable (an empty repository included). */
export async function probeGitUrl(url: string, exec: typeof execCapped = execCapped): Promise<string | null> {
  try {
    await exec('git', ['ls-remote', '--exit-code', '--', url, 'HEAD'], {
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: CHAT_GIT_PROTOCOLS, GIT_SSH_COMMAND: process.env['GIT_SSH_COMMAND'] ?? 'ssh -o BatchMode=yes' },
    });
    return null;
  } catch (err) {
    const e = err as { code?: unknown; stderr?: unknown; message?: string; killed?: boolean };
    // Exit 2: reachable, no HEAD (an empty repository) — it can still be cloned.
    if (e.code === 2) return null;
    if (e.killed === true) return "this computer can't reach that host right now (no answer in 15 s); check the address, then ask again";
    return probeVerdict(typeof e.stderr === 'string' && e.stderr !== '' ? e.stderr : e.message ?? '');
  }
}

export interface OnboardResolveDeps {
  /** The stored projects (never the synthesized Unfiled). */
  projects(): Promise<Array<{ id: string; name: string }>>;
  repos(): Promise<RepoEntry[]>;
  /** The registry ids (or legacy names) of a project's `crew.repo` members. */
  projectRepoRefs(projectId: string): Promise<string[]>;
  /** The `origin` of a registered checkout (the daemon's own clones record no `git_url`); `null` when unknown. */
  originOf(rootPath: string): Promise<string | null>;
  /** {@link probeGitUrl}. */
  probe(url: string): Promise<string | null>;
  /** Where a clone of `name` goes, home-relative (`~/.wicked/repos/<name>`). */
  checkoutOf(name: string): string;
  /** What already sits where a clone of `name` goes: `null` = nothing; else its `origin` ('' when it has none). A clone
   *  there is skipped and the folder registered as it is, so it must be this repository. */
  occupant(name: string): Promise<string | null>;
}

export interface OnboardTurn {
  pid: string;
  chatId: string;
  turnId: string;
  seat: string;
  /** The chat's own project (`null`: none, or Unfiled): the default when the words name none. */
  chatProjectId: string | null;
}

const readKey = (url: string): string | null => {
  const r = readGitUrl(url);
  return r.ok ? r.key : null;
};

/** The registered repository with this address (by its recorded URL, else its checkout's origin), or `null`. */
async function registeredAs(key: string, repos: readonly RepoEntry[], originOf: OnboardResolveDeps['originOf']): Promise<RepoEntry | null> {
  const byUrl = repos.find((r) => typeof r.git_url === 'string' && readKey(r.git_url) === key);
  if (byUrl !== undefined) return byUrl;
  const origins = await Promise.all(repos.slice(0, 60).map(async (r) => (typeof r.git_url === 'string' ? null : originOf(r.root_path).catch(() => null))));
  const i = origins.findIndex((o) => o !== null && readKey(o) === key);
  return i === -1 ? null : repos[i]!;
}

/** Why a new registration of `name` from `key` can't go ahead (the name's registry id is taken, or its clone folder
 *  holds another checkout); `null` = it can. Checked when the card is drawn and again on Go. */
export async function newRegistrationRefusal(name: string, key: string, repos: readonly RepoEntry[], occupant: OnboardResolveDeps['occupant'], checkout: string): Promise<string | null> {
  if (!SAFE_REPO_NAME.test(name) || name.length > 128) {
    return `“${name}” can't be a repository name (letters, digits, dots, hyphens and underscores; starting with a letter or digit)`;
  }
  // Core keys a repo by the slug of its name: `foo_bar` would replace a registered `foo-bar`, its projects and links too.
  const id = coreRepoSlug(name);
  const taken = repos.find((r) => r.id === id || r.name === name);
  if (taken !== undefined) return `a different repository is already registered as “${taken.name}”; give this one another name`;
  const there = await occupant(name);
  if (there !== null && readKey(there) !== key) return `${checkout} already holds another checkout; give this one another name`;
  return null;
}

/** The block → an `onboard` card, every line crew's. What can't go ahead is `blocked`, with what to do instead. */
export async function resolveOnboard(block: OnboardBlockBody, turn: OnboardTurn, deps: OnboardResolveDeps): Promise<ArtifactProposal> {
  const blocked: string[] = [];
  const read = readGitUrl(block.onboard.url);
  const shown = withoutCredentials(block.onboard.url).slice(0, 2048);
  const projects = await deps.projects();
  let project: { id: string; name: string } | null = null;
  const words = block.onboard.project?.trim() ?? '';
  if (words !== '') {
    const m = matchProject(projects, words);
    if ('one' in m) project = m.one;
    else if ('many' in m) blocked.push(`more than one project is named “${words}” (${m.many.map((p) => `${p.name}, ${p.id}`).join('; ')}): say which`);
    else {
      const names = projects.map((p) => p.name);
      blocked.push(`no project is named “${words}”${names.length > 0 ? ` (projects here: ${names.join(', ')})` : ' (there are no projects yet)'}. `
        + 'Create it on Projects → New project, or name one of these, then ask again');
    }
  } else if (turn.chatProjectId !== null) {
    project = projects.find((p) => p.id === turn.chatProjectId) ?? null;
  }
  const name = (block.onboard.name ?? '').trim() || (read.ok ? read.name : '');
  let existing: { id: string; name: string } | null = null;
  // The address as it was given is never repeated when refused (it may carry a token).
  if (!read.ok) blocked.push(`that address can't be added: ${read.reason}`);
  else {
    const repos = await deps.repos();
    const same = await registeredAs(read.key, repos, deps.originOf);
    if (same !== null) {
      existing = { id: same.id, name: same.name };
      if (project === null) blocked.push(`${same.name} is already registered; name the project to add it to`);
      else if ((await deps.projectRepoRefs(project.id)).some((ref) => ref === same.id || ref === same.name)) {
        blocked.push(`${same.name} is already in ${project.name}; nothing to add`);
      }
    } else {
      const refused = await newRegistrationRefusal(name, read.key, repos, deps.occupant, deps.checkoutOf(name));
      if (refused !== null) blocked.push(refused);
      else {
        const unreadable = await deps.probe(read.url);
        if (unreadable !== null) blocked.push(unreadable);
      }
    }
  }
  const onboard: ProposalOnboard = {
    url: read.ok ? read.url : shown,
    name: existing?.name ?? name,
    checkout: existing === null && name !== '' ? deps.checkoutOf(name) : null,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    existing,
  };
  const into = project !== null ? `, added to ${project.name}` : '';
  return {
    pid: turn.pid,
    chatId: turn.chatId,
    turnId: turn.turnId,
    kind: 'onboard',
    seat: turn.seat,
    what: existing !== null
      ? { entry: null, title: existing.name, label: `Add to a project · ${existing.name}`, outcome: `Adds the registered ${existing.name} to ${project?.name ?? 'a project'}. Nothing is cloned and no onboarding starts.` }
      : { entry: null, title: name || 'repository', label: `Add a repository · ${name || 'repository'}`, outcome: `Cloned to this computer, registered${into}, and onboarded: its code map is built so jobs and chats can read it.` },
    brief: null,
    reason: block.reason ?? null,
    sources: [],
    repos: [],
    helpers: null,
    time: null,
    stops: null,
    filedIn: { projectId: project?.id ?? null, label: project?.name ?? 'Not in a project' },
    onboard,
    blocked: blocked.length > 0 ? blocked[0]! : null,
  };
}

export interface OnboardLauncherDeps {
  /** Every run id the engine knows (the onboarding run is named by the proposal's identity). */
  sessions(): Promise<string[]>;
  repos(): Promise<RepoEntry[]>;
  /** The registry ids (or legacy names) of a project's `crew.repo` members. */
  projectRepoRefs(projectId: string): Promise<string[]>;
  /** {@link OnboardResolveDeps.occupant}. */
  occupant(name: string): Promise<string | null>;
  checkoutOf(name: string): string;
  /** The body of `POST /repos` (`routes.ts` `registerAndOnboard`), with the onboarding run named by the proposal and the
   *  clone held to {@link CHAT_GIT_PROTOCOLS}. */
  register(
    data: { name: string; gitUrl: string; projectId?: string; channel: 'studio' },
    ctx: { actor: Actor; runId: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** The one attach path (`attachRepoToProject`). */
  attach(projectId: string, repoId: string, actor: Actor): Promise<void>;
}

/**
 * Go on an `onboard` card: the same path as `POST /repos {gitUrl, projectId}`, or only the attach for a registered one.
 * Done = the onboarding run (named by the proposal) exists AND the repository is in the card's project. A Go interrupted
 * between the two (a crash, a refused attach) finishes the attach on Go again instead of being recorded as done from the
 * run alone (crew-0182 review).
 */
export class OnboardLauncher implements ProposalDispatcher {
  constructor(private readonly deps: OnboardLauncherDeps) {}

  private async repoOf(name: string): Promise<RepoEntry | undefined> {
    const repos = await this.deps.repos();
    return repos.find((r) => r.name === name) ?? repos.find((r) => r.id === coreRepoSlug(name));
  }

  private async member(projectId: string, repo: RepoEntry): Promise<boolean> {
    return (await this.deps.projectRepoRefs(projectId)).some((ref) => ref === repo.id || ref === repo.name);
  }

  /** Never adopted from the run alone (the attach may still be left): every Go runs {@link launch}, which is idempotent
   *  under the run id's lock (`LaunchOnceRegistry`): a run that exists is never started again, only what is left is done. */
  async find(): Promise<boolean> {
    return false;
  }

  async launch(d: ProposalDispatch): Promise<void> {
    const o = d.resolution.onboard;
    if (d.kind !== 'onboard' || o === undefined) throw new Error(`the onboard launcher takes only an onboard proposal (got ${d.kind})`);
    if (o.existing !== null) {
      if (o.projectId === null) throw new Error(`${o.existing.name} is already registered and no project was named`);
      await this.deps.attach(o.projectId, o.existing.id, d.actor);
      return;
    }
    const read = readGitUrl(o.url);
    if (!read.ok) throw new Error(read.reason);
    // Its run exists (an earlier Go got that far): only the attach is left.
    if ((await this.deps.sessions()).includes(d.identity.runId)) {
      await this.attachLeft(o, d.actor);
      return;
    }
    // The registry may have moved since the card was drawn: the name and its folder are checked again before anything.
    const repos = await this.deps.repos();
    const there = await this.deps.occupant(o.name);
    // Registered under this name from this very address (an earlier Go whose onboarding did not start): registering it
    // again changes nothing else, and onboarding is tried again.
    const ours = repos.some((r) => r.name === o.name) && there !== null && readKey(there) === read.key;
    const again = ours ? null : await newRegistrationRefusal(o.name, read.key, repos, this.deps.occupant, this.deps.checkoutOf(o.name));
    if (again !== null) throw new Error(`${o.name} was not added: ${again}`);
    const out = await this.deps.register(
      { name: o.name, gitUrl: read.url, ...(o.projectId !== null ? { projectId: o.projectId } : {}), channel: 'studio' },
      { actor: d.actor, runId: d.identity.runId },
    );
    const error = typeof out.body['error'] === 'string' ? out.body['error'] : `it was refused (${out.status})`;
    if (out.status !== 201) throw new Error(`${o.name} was not added: ${error}`);
    if (typeof out.body['onboardError'] === 'string') {
      throw new Error(`${o.name} is registered${o.projectName !== null ? ` in ${o.projectName}` : ''}, but onboarding could not start: ${out.body['onboardError']}`);
    }
    if (o.projectId !== null && out.body['projectAttached'] !== true) {
      const why = typeof out.body['projectAttachError'] === 'string' ? out.body['projectAttachError'] : 'it was not attached';
      throw new Error(`${o.name} is registered and onboarding started, but it was not added to ${o.projectName ?? o.projectId}: ${why}. Go again adds it`);
    }
  }

  private async attachLeft(o: NonNullable<ArtifactProposal['onboard']>, actor: Actor): Promise<void> {
    if (o.projectId === null) return;
    const repo = await this.repoOf(o.name);
    if (repo === undefined) throw new Error(`${o.name} is no longer registered; ask again in the chat`);
    if (!(await this.member(o.projectId, repo))) await this.deps.attach(o.projectId, repo.id, actor);
  }

  async live(): Promise<boolean> {
    return false;
  }
}
