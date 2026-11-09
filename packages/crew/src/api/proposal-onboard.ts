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
import type { Actor, ArtifactProposal, ProposalIdentity, ProposalOnboard, RepoEntry } from '../core/types.js';
import type { ProposalDispatch, ProposalDispatcher } from './chat-proposals.js';

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

const SCP = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/)([A-Za-z0-9._~/-]+)$/;

/**
 * A git address crew will clone: `https://host/owner/repo(.git)`, `ssh://[user@]host[:port]/path` or
 * `user@host:owner/repo(.git)`. Anything else (a local path, `file://`, `ext::`, plain `http://`, an address carrying a
 * password or token) is refused with its reason. `key` compares two spellings of one repository (host lowercased, no
 * `.git`, no trailing slash, case-insensitive); `name` is its last path segment.
 */
export function readGitUrl(raw: string): GitUrlReading {
  const url = raw.trim();
  if (url === '' || /[\s\u0000-\u001f\u007f]/.test(url)) return { ok: false, reason: 'the address has spaces or control characters in it' };
  let host: string;
  let path: string;
  const scp = SCP.exec(url);
  if (scp !== null) {
    host = scp[2]!.toLowerCase();
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
    host = `${u.hostname.toLowerCase()}${u.port !== '' ? `:${u.port}` : ''}`;
    path = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  }
  const segments = path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/');
  if (host === '' || segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return { ok: false, reason: 'the address names no repository path' };
  }
  const name = segments[segments.length - 1]!;
  return { ok: true, url, key: `${host}/${segments.join('/')}`.toLowerCase(), name };
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

/** `git ls-remote` with no prompt: `null` when the address is readable (an empty repository included). */
export async function probeGitUrl(url: string, exec: typeof execCapped = execCapped): Promise<string | null> {
  try {
    await exec('git', ['ls-remote', '--exit-code', '--', url, 'HEAD'], {
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env['GIT_SSH_COMMAND'] ?? 'ssh -o BatchMode=yes' },
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
  /** The `origin` of a registered checkout, for one registered without a URL; `null` when unknown. */
  originOf(rootPath: string): Promise<string | null>;
  /** {@link probeGitUrl}. */
  probe(url: string): Promise<string | null>;
  /** Where a clone of `name` goes, home-relative (`~/.wicked/repos/<name>`). */
  checkoutOf(name: string): string;
}

export interface OnboardTurn {
  pid: string;
  chatId: string;
  turnId: string;
  seat: string;
  /** The chat's own project (`null`: none, or Unfiled): the default when the words name none. */
  chatProjectId: string | null;
}

/** The block → an `onboard` card, every line crew's. What can't go ahead is `blocked`, with what to do instead. */
export async function resolveOnboard(block: OnboardBlockBody, turn: OnboardTurn, deps: OnboardResolveDeps): Promise<ArtifactProposal> {
  const blocked: string[] = [];
  const read = readGitUrl(block.onboard.url);
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
  if (!read.ok) blocked.push(`${block.onboard.url.slice(0, 200)} can't be added: ${read.reason}`);
  else {
    const repos = await deps.repos();
    const sameUrl = repos.find((r) => typeof r.git_url === 'string' && readKey(r.git_url) === read.key);
    const sameName = repos.find((r) => r.id === name || r.name === name);
    if (sameUrl !== undefined) existing = { id: sameUrl.id, name: sameUrl.name };
    else if (sameName !== undefined) {
      // Registered from a folder: the same repository when its checkout's origin is this address.
      const origin = sameName.git_url === undefined ? await deps.originOf(sameName.root_path).catch(() => null) : null;
      if (origin !== null && readKey(origin) === read.key) existing = { id: sameName.id, name: sameName.name };
      else blocked.push(`a different repository is already registered as “${name}”; give this one another name`);
    } else if (!SAFE_REPO_NAME.test(name) || name.length > 128) {
      blocked.push(`“${name}” can't be a repository name (letters, digits, dots, hyphens and underscores; starting with a letter or digit)`);
    }
    if (existing !== null) {
      if (project === null) blocked.push(`${existing.name} is already registered; name the project to add it to`);
      else if ((await deps.projectRepoRefs(project.id)).some((ref) => ref === existing!.id || ref === existing!.name)) {
        blocked.push(`${existing.name} is already in ${project.name}; nothing to add`);
      }
    } else if (blocked.length === 0) {
      const unreadable = await deps.probe(read.url);
      if (unreadable !== null) blocked.push(unreadable);
    }
  }
  const onboard: ProposalOnboard = {
    url: read.ok ? read.url : block.onboard.url.slice(0, 2048),
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

const readKey = (url: string): string | null => {
  const r = readGitUrl(url);
  return r.ok ? r.key : null;
};

export interface OnboardLauncherDeps {
  /** Every run id the engine knows (a Go again adopts the onboarding run its first Go started). */
  sessions(): Promise<string[]>;
  /** The body of `POST /repos` (`routes.ts` `registerAndOnboard`), with the onboarding run named by the proposal. */
  register(
    data: { name: string; gitUrl: string; projectId?: string; channel: 'studio' },
    ctx: { actor: Actor; runId: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** The one attach path (`attachRepoToProject`). */
  attach(projectId: string, repoId: string, actor: Actor): Promise<void>;
}

/** Go on an `onboard` card: the same path as `POST /repos {gitUrl, projectId}`, or only the attach for a registered one. */
export class OnboardLauncher implements ProposalDispatcher {
  constructor(private readonly deps: OnboardLauncherDeps) {}

  async find(identity: ProposalIdentity): Promise<boolean> {
    return (await this.deps.sessions()).includes(identity.runId);
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
    const out = await this.deps.register(
      { name: o.name, gitUrl: read.url, ...(o.projectId !== null ? { projectId: o.projectId } : {}), channel: 'studio' },
      { actor: d.actor, runId: d.identity.runId },
    );
    const error = typeof out.body['error'] === 'string' ? out.body['error'] : `it was refused (${out.status})`;
    if (out.status !== 201) throw new Error(`${o.name} was not added: ${error}`);
    if (typeof out.body['onboardError'] === 'string') {
      throw new Error(`${o.name} is registered${o.projectName !== null ? ` in ${o.projectName}` : ''}, but onboarding could not start: ${out.body['onboardError']}`);
    }
  }

  async live(): Promise<boolean> {
    return false;
  }
}
