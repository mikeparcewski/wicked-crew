/**
 * `/api/v1/projects` — the complete v1 surface of DES-PROJECT-001 §5.2 (9 routes):
 *
 *   POST   /projects                    create {name, description?}
 *   GET    /projects                    list (includes the synthesized `default`; ?status=)
 *   GET    /projects/:id                detail + members
 *   PATCH  /projects/:id                rename / describe / archive / restore
 *   GET    /projects/:id/members        list members
 *   POST   /projects/:id/members        attach {kind, ref, meta?}
 *   DELETE /projects/:id/members/:mid   detach
 *   GET    /projects/:id/activity       merged feed, cursor-paginated
 *   GET    /projects/:id/prompts        open interaction requests across member runs
 *
 * …plus the project code graph (projects/graph.ts) — the repo-scoped graph trio, one scope up:
 *
 *   GET    /projects/:id/graph               what the co-located graph holds, and what it cannot answer
 *   POST   /projects/:id/graph/refresh       incremental (re)build over every `crew.repo` member
 *   GET    /projects/:id/graph/blast-radius  ?name= — dependents across member repos, each attributed
 *   GET    /projects/:id/graph/search        ?name= — symbol resolution across member repos
 *
 * Route-layer rules the engine cannot own:
 * - The `default` project ("Unfiled") is SYNTHESIZED here (ADR §7): its members are the runs
 *   with no explicit membership row; it lists, feeds, and prompts, and rejects PATCH/attach.
 * - `crew.*` member refs are existence-checked here at attach time (404 on unknown run/repo) —
 *   never by the engine, and never with foreign keys (members may outlive what they point to).
 * - Bus events emit POST-COMMIT from these handlers with type-inclusive idempotency keys (§4).
 * - Engine error → status mapping: "not registered" 404 · "already in use"/"archived"/"default"
 *   409 · anything else 400. A pre-0.6.0 addon answers 501 (ProjectsUnsupportedError), never 400.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CoreAdapter } from '../core/adapter.js';
import { ProjectsUnsupportedError } from '../core/adapter.js';
import type { Project, ProjectMember, InteractionRequest } from '../core/types.js';
import { API_PREFIX } from '../api/api-prefix.js';
import type { ProjectBus } from './events.js';
import {
  MEMBERSHIP_ATTACHED,
  MEMBERSHIP_DETACHED,
  PROJECT_ARCHIVED,
  PROJECT_CREATED,
  PROJECT_UPDATED,
  membershipAttachedKey,
  membershipDetachedKey,
  projectArchivedKey,
  projectCreatedKey,
  projectUpdatedKey,
} from './events.js';
import type { MembershipIndex } from './membership-index.js';
import { ProjectSettingsStore } from './settings.js';
import { buildActivityPage } from './activity.js';
import {
  CO_LOCATION_NOTE,
  ProjectGraphEngineTooOldError,
  projectBlastRadius,
  projectGraphStatus,
  projectSymbolSearch,
  queryable,
  refreshProjectGraph,
} from './graph.js';
import type { ProjectGraphStatus } from '../core/types.js';
import { writeCharter } from './charter.js';
import { AuditLog } from '../api/audit.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import type { Actor } from '../core/types.js';

const V = API_PREFIX;

/** The reserved, synthesized "Unfiled" project id (ADR §1.1/§7). */
export const DEFAULT_PROJECT_ID = 'default';

// Exported for tests/wire-contract.test.ts (the request-direction drift guard).
export const CreateProjectSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().optional(),
  })
  .strict();

export const UpdateProjectSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().optional(),
    status: z.enum(['active', 'archived']).optional(),
    /** DES-MERGE-001 §7.1 — the project's wicked-interactive docs root. Explicitly NULLABLE:
     *  null clears the binding back to the shared default root, which is a different act from
     *  omitting the key (leave it alone). Stored crew-side (see settings.ts), not in the engine. */
    interactiveRoot: z.string().min(1).nullable().optional(),
  })
  .strict();

/** `<product>.<noun>` — the engine re-validates; this is the 400-with-names layer. */
export const AttachMemberSchema = z
  .object({
    kind: z.string().min(3).max(64).regex(/^[a-z0-9_-]+\.[a-z0-9_-]+$/, 'kind must be <product>.<noun>, lowercase'),
    ref: z.string().min(1).max(512),
    meta: z.record(z.string(), z.unknown()).optional(),
    attachedBy: z.enum(['studio', 'interactive', 'cli', 'api']).optional(),
  })
  .strict();

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Engine error → HTTP status (the mapping in the module doc). */
function engineErrorStatus(err: unknown): number {
  if (err instanceof ProjectsUnsupportedError) return 501;
  const msg = message(err);
  if (/not registered/i.test(msg)) return 404;
  if (/already in use|archived|'default'|synthesized/i.test(msg)) return 409;
  return 400;
}

/** The synthesized `default` row (never stored; ADR §7). */
function defaultProject(): Project {
  return {
    id: DEFAULT_PROJECT_ID,
    name: 'Unfiled',
    description: 'Runs and chats not filed into any project (synthesized; read-only).',
    status: 'active',
    scope: '',
    created_at: 0,
    updated_at: 0,
  };
}

export interface ProjectRoutesDeps {
  bus: ProjectBus | null;
  index: MembershipIndex;
  log: (msg: string) => void;
  /** Crew-side per-project settings (DES-MERGE-001 §7.1's `interactiveRoot`). Optional so the
   *  route-level unit tests keep their existing two-line deps; `registerRoutes` always supplies
   *  the SAME instance the interactive proxy reads. */
  settings?: ProjectSettingsStore;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  adapter: CoreAdapter,
  deps: ProjectRoutesDeps,
  // Defaulted like the deps above — to a NOOP trail, so a directly-driven
  // route set (unit tests) never writes the real ~/.wicked-crew/audit.log
  // (task #88). The real trail always arrives from `createServer`.
  security: { audit: AuditLog } = { audit: AuditLog.noop() },
): void {
  const { bus, index, log } = deps;
  const { audit } = security;
  const settings = deps.settings ?? new ProjectSettingsStore();

  /** The engine's row plus its crew-side settings — the ONE `Project` shape the wire carries
   *  (§7.1). `interactiveRoot` is always present and explicitly null when unbound, so a client
   *  can tell "shared default" from "this field does not exist on this daemon". */
  const withSettings = (project: Project): Project => ({
    ...project,
    interactiveRoot: settings.get(project.id).interactiveRoot ?? null,
  });
  // The AUTHENTICATED actor for event/audit stamping — locked decision #6
  // replaces the hardcoded 'api' strings these emits used to carry. Falls back
  // to the local actor when no auth hooks are installed (direct-driven tests).
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;

  /** All explicit `crew.run`/`crew.chat` member refs across every stored project. */
  async function filedRunRefs(): Promise<Set<string>> {
    const filed = new Set<string>();
    for (const project of await adapter.projectList()) {
      for (const member of await adapter.projectMembers(project.id)) {
        if (member.member_kind === 'crew.run' || member.member_kind === 'crew.chat') {
          filed.add(member.member_ref);
        }
      }
    }
    return filed;
  }

  /** The synthesized default project's members (ADR §7: "all runs/chats known to the engine
   *  that have no explicit membership row" — computed, never stored). Runs come from the store;
   *  chats from the LIVE pool (chats are not persisted), guarded because the chat surface is an
   *  optional engine capability. */
  async function defaultMembers(): Promise<ProjectMember[]> {
    const filed = await filedRunRefs();
    const synthesize = (kind: string, ref: string): ProjectMember => ({
      id: `default:${kind}:${ref}`,
      project_id: DEFAULT_PROJECT_ID,
      member_kind: kind,
      member_ref: ref,
      meta: null,
      attached_at: 0,
      attached_by: 'api',
    });
    const members = (await adapter.sessions())
      .filter((id) => !filed.has(id))
      .map((id) => synthesize('crew.run', id));
    try {
      for (const chat of await adapter.chatList()) {
        const chatId = (chat as { chatId?: string }).chatId;
        if (typeof chatId === 'string' && !filed.has(chatId)) {
          members.push(synthesize('crew.chat', chatId));
        }
      }
    } catch {
      // No chat surface on this build (ChatUnsupportedError) — runs alone are the honest set.
    }
    return members;
  }

  /** Resolve a project's run/chat member refs (real or synthesized default). */
  async function memberRunRefs(projectId: string): Promise<string[] | null> {
    if (projectId === DEFAULT_PROJECT_ID) {
      return (await defaultMembers()).map((m) => m.member_ref);
    }
    const project = await adapter.projectGet(projectId);
    if (project === null) return null;
    return (await adapter.projectMembers(projectId))
      .filter((m) => m.member_kind === 'crew.run' || m.member_kind === 'crew.chat')
      .map((m) => m.member_ref);
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  app.post(`${V}/projects`, async (req, reply) => {
    const parsed = CreateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    try {
      const project = await adapter.projectCreate(parsed.data.name, parsed.data.description);
      // Post-commit, in order: bus event, then the (best-effort) foundation charter.
      bus?.emit(
        PROJECT_CREATED,
        { project_id: project.id, name: project.name, scope: project.scope, actor: actorOf(req).id },
        projectCreatedKey(project.id),
      );
      audit.record('project.created', actorOf(req), { detail: { projectId: project.id, name: project.name } });
      void writeCharter(adapter, project, 'created', log);
      return reply.code(201).send({ project });
    } catch (err) {
      return reply.code(engineErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.get(`${V}/projects`, async (req, reply) => {
    const { status } = req.query as { status?: string };
    if (status !== undefined && status !== 'active' && status !== 'archived') {
      return reply.code(400).send({ error: `unknown status filter '${status}' (active|archived)` });
    }
    try {
      const stored = await adapter.projectList();
      const all = [defaultProject(), ...stored];
      const projects = (status === undefined ? all : all.filter((p) => p.status === status)).map(withSettings);
      return { projects };
    } catch (err) {
      return reply.code(engineErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.get(`${V}/projects/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      if (id === DEFAULT_PROJECT_ID) {
        return { project: withSettings(defaultProject()), members: await defaultMembers() };
      }
      const project = await adapter.projectGet(id);
      if (project === null) return reply.code(404).send({ error: `Project ${id} not found` });
      return { project: withSettings(project), members: await adapter.projectMembers(id) };
    } catch (err) {
      return reply.code(engineErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.patch(`${V}/projects/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    if (id === DEFAULT_PROJECT_ID) {
      return reply.code(409).send({ error: "the synthesized 'default' project cannot be modified" });
    }
    try {
      const before = await adapter.projectGet(id);
      if (before === null) return reply.code(404).send({ error: `Project ${id} not found` });
      // The crew-side half of the patch, applied before the engine half so a settings-only
      // PATCH never needs an engine round-trip at all (§7.1).
      if (parsed.data.interactiveRoot !== undefined) {
        settings.set(id, { interactiveRoot: parsed.data.interactiveRoot });
      }
      const touchesEngine =
        parsed.data.name !== undefined ||
        parsed.data.description !== undefined ||
        parsed.data.status !== undefined;
      if (!touchesEngine) {
        // Settings-only: no engine write (an all-null projectUpdate would bump updated_at for
        // nothing) and no `project.updated` emit — `interactiveRoot` is a crew-side binding,
        // not part of ADR §4's project event vocabulary.
        return { project: withSettings(before) };
      }
      const project = await adapter.projectUpdate(id, parsed.data);
      // Archive gets its own event type; everything else (rename/describe/restore) is `updated`
      // with the changed fields named (ADR §4).
      if (parsed.data.status === 'archived' && before?.status !== 'archived') {
        bus?.emit(
          PROJECT_ARCHIVED,
          { project_id: project.id, actor: actorOf(req).id },
          projectArchivedKey(project.id, project.updated_at),
        );
        // Archive is the admin-gated write (task #88) — WHO archived it is audit-worthy.
        audit.record('project.archived', actorOf(req), { detail: { projectId: project.id } });
        void writeCharter(adapter, project, 'archived', log);
      } else {
        const changed: Record<string, unknown> = {};
        if (parsed.data.name !== undefined) changed['name'] = parsed.data.name;
        if (parsed.data.description !== undefined) changed['description'] = parsed.data.description;
        if (parsed.data.status !== undefined) changed['status'] = parsed.data.status;
        bus?.emit(
          PROJECT_UPDATED,
          { project_id: project.id, changed, actor: actorOf(req).id },
          projectUpdatedKey(project.id, project.updated_at),
        );
        void writeCharter(
          adapter,
          project,
          parsed.data.status === 'active' && before?.status === 'archived' ? 'restored' : 'updated',
          log,
        );
      }
      return { project: withSettings(project) };
    } catch (err) {
      return reply.code(engineErrorStatus(err)).send({ error: message(err) });
    }
  });

  // ── Members ──────────────────────────────────────────────────────────────────

  app.get(`${V}/projects/:id/members`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      if (id === DEFAULT_PROJECT_ID) return { projectId: id, members: await defaultMembers() };
      const project = await adapter.projectGet(id);
      if (project === null) return reply.code(404).send({ error: `Project ${id} not found` });
      return { projectId: id, members: await adapter.projectMembers(id) };
    } catch (err) {
      return reply.code(engineErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.post(`${V}/projects/:id/members`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = AttachMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    if (id === DEFAULT_PROJECT_ID) {
      return reply
        .code(409)
        .send({ error: "cannot attach members to the synthesized 'default' project" });
    }
    const { kind, ref, meta, attachedBy } = parsed.data;
    try {
      // Referential integrity for crew.* kinds lives HERE, at attach time (ADR §1.2): 404 on an
      // unknown run/repo — but a member may legitimately outlive what it points to later.
      if (kind === 'crew.run' && !(await adapter.sessions()).includes(ref)) {
        return reply.code(404).send({ error: `Run ${ref} not found` });
      }
      if (kind === 'crew.repo' && !(await adapter.listRepos()).some((r) => r.id === ref)) {
        return reply.code(404).send({ error: `Repo ${ref} not found` });
      }
      const { member, created } = await adapter.projectMemberAttach(id, kind, ref, meta, attachedBy);
      if (created) {
        if (kind === 'crew.run' || kind === 'crew.chat') index.set(ref, id);
        bus?.emit(
          MEMBERSHIP_ATTACHED,
          // `attachedBy` stays what it is — the SURFACE that attached (studio/
          // interactive/cli/api), persisted on the row. The event's `actor` is
          // now the authenticated principal, not that caller-supplied label
          // (locked decision #6: no more spoofable actor strings).
          { project_id: id, member: { kind, ref }, actor: actorOf(req).id, surface: attachedBy ?? 'api' },
          membershipAttachedKey(id, kind, ref, member.attached_at),
        );
      }
      return reply.code(created ? 201 : 200).send({ member, created });
    } catch (err) {
      return reply.code(engineErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.delete(`${V}/projects/:id/members/:mid`, async (req, reply) => {
    const { id, mid } = req.params as { id: string; mid: string };
    if (id === DEFAULT_PROJECT_ID) {
      return reply
        .code(409)
        .send({ error: "the synthesized 'default' project has no stored members to detach" });
    }
    try {
      // Read the member BEFORE detaching so the event can name (kind, ref) — the row's id alone
      // is opaque to consumers.
      const member = (await adapter.projectMembers(id)).find((m) => m.id === mid);
      const removed = await adapter.projectMemberDetach(id, mid);
      if (!removed) {
        return reply.code(404).send({ error: `No member ${mid} on project ${id}` });
      }
      if (member !== undefined && (member.member_kind === 'crew.run' || member.member_kind === 'crew.chat')) {
        index.delete(member.member_ref);
      }
      bus?.emit(
        MEMBERSHIP_DETACHED,
        {
          project_id: id,
          member: { kind: member?.member_kind ?? 'unknown', ref: member?.member_ref ?? mid },
          actor: actorOf(req).id,
        },
        membershipDetachedKey(id, mid, Date.now()),
      );
      return { removed: true };
    } catch (err) {
      return reply.code(engineErrorStatus(err)).send({ error: message(err) });
    }
  });

  // ── The two project reads that make multi-skin real (§5.2/§5.3) ─────────────

  app.get(`${V}/projects/:id/activity`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    const pageSize = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200);
    try {
      const refs = await memberRunRefs(id);
      if (refs === null) return reply.code(404).send({ error: `Project ${id} not found` });
      const { entries, nextCursor } = await buildActivityPage(
        adapter,
        id,
        refs,
        bus?.dbPath ?? null,
        cursor,
        pageSize,
      );
      return { projectId: id, entries, nextCursor };
    } catch (err) {
      return reply.code(engineErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.get(`${V}/projects/:id/prompts`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const refs = await memberRunRefs(id);
      if (refs === null) return reply.code(404).send({ error: `Project ${id} not found` });
      // Per-member queries, not a daemon-wide scan filtered in-process: the cost scales with
      // THIS project's members, never with global open-prompt volume (Copilot, #243).
      const prompts: InteractionRequest[] = [];
      for (const ref of refs) {
        const rows = await adapter.interactionRequests(ref, 'open');
        if (rows === null) {
          // Distinguish "cannot read the durable table" from "no prompts" — the FINDING-050 rule.
          return reply.code(501).send({
            error:
              'The durable prompt inbox needs a wicked-core build with the interaction_requests binding (wicked-core-ts >= 0.6.0)',
          });
        }
        prompts.push(...rows);
      }
      prompts.sort((a, b) => b.created_at - a.created_at);
      return { projectId: id, prompts };
    } catch (err) {
      return reply.code(engineErrorStatus(err)).send({ error: message(err) });
    }
  });

  // ── The project code graph — every member repo, co-located, NOT linked ───────
  //
  // Mirrors the repo-scoped trio (`/repos/:id/graph`, `/repos/:id/graph/blast-radius`,
  // `/repos/:id/domain-graph`) in shape, caps and error handling, one scope up. The one thing it
  // adds to every payload is PROVENANCE: a hit that does not say which repo it came from is not an
  // answer to a cross-repo question. See projects/graph.ts for the co-location/linkage limit.

  /** The synthesized `default` project can never hold a repo — its membership is computed from
   *  unfiled runs and chats (ADR §7), and `crew.repo` is not among the kinds it synthesizes. Said
   *  here, with its own sentence, rather than by handing the engine an id it does not store. */
  function defaultProjectGraph(): ProjectGraphStatus {
    return {
      projectId: DEFAULT_PROJECT_ID,
      state: 'no-repo-members',
      detail:
        "the synthesized 'default' project holds unfiled runs and chats only — it has no repo " +
        'members and cannot have a code graph. Create a project and attach repos to it.',
      dbPath: null,
      repos: [],
      missingRepos: [],
      staleRepos: [],
      linkage: 'co-located',
      note: CO_LOCATION_NOTE,
      updatedAt: null,
    };
  }

  /** Engine capability gaps map to 501, everything else to the projects mapping. */
  function graphErrorStatus(err: unknown): number {
    return err instanceof ProjectGraphEngineTooOldError ? 501 : engineErrorStatus(err);
  }

  app.get(`${V}/projects/:id/graph`, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === DEFAULT_PROJECT_ID) return { status: defaultProjectGraph() };
    try {
      const project = await adapter.projectGet(id);
      if (project === null) return reply.code(404).send({ error: `Project ${id} not found` });
      // Always 200: "this project has no repos" and "its graph was never built" are ANSWERS about
      // the graph's standing, which is what this route reports. The query routes below are where
      // they become a refusal, because there they are the reason a question cannot be answered.
      return { status: await projectGraphStatus(adapter, id) };
    } catch (err) {
      return reply.code(graphErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.post(`${V}/projects/:id/graph/refresh`, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === DEFAULT_PROJECT_ID) {
      return reply.code(409).send({ error: defaultProjectGraph().detail });
    }
    try {
      const project = await adapter.projectGet(id);
      if (project === null) return reply.code(404).send({ error: `Project ${id} not found` });
      // Synchronous: indexing runs to completion before this answers, so the response describes a
      // graph that IS built rather than one that was asked for. Bounded per repo by graph.ts's
      // index timeout; concurrent callers coalesce onto the one in-flight refresh.
      return await refreshProjectGraph(adapter, id);
    } catch (err) {
      return reply.code(graphErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.get(`${V}/projects/:id/graph/blast-radius`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { name?: string };
    if (q.name === undefined || q.name.trim() === '') {
      return reply.code(400).send({ error: 'name query parameter required' });
    }
    if (id === DEFAULT_PROJECT_ID) {
      return reply.code(404).send({ error: defaultProjectGraph().detail, status: defaultProjectGraph() });
    }
    try {
      const project = await adapter.projectGet(id);
      if (project === null) return reply.code(404).send({ error: `Project ${id} not found` });
      const ready = await queryable(adapter, id);
      // The FINDING-050 / R3 rule: a project that cannot answer says WHY and HOW TO FIX IT. `[]`
      // here would be a well-formed reply meaning "nothing depends on this symbol", which is a
      // different — and dangerous — statement from "there is no graph to ask".
      if (!ready.ok) {
        const code = ready.status.state === 'engine-too-old' ? 501 : 404;
        return reply.code(code).send({ error: ready.status.detail, status: ready.status });
      }
      return reply.send(await projectBlastRadius(ready, q.name.trim()));
    } catch (err) {
      return reply.code(graphErrorStatus(err)).send({ error: message(err) });
    }
  });

  app.get(`${V}/projects/:id/graph/search`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { name?: string };
    if (q.name === undefined || q.name.trim() === '') {
      return reply.code(400).send({ error: 'name query parameter required' });
    }
    if (id === DEFAULT_PROJECT_ID) {
      return reply.code(404).send({ error: defaultProjectGraph().detail, status: defaultProjectGraph() });
    }
    try {
      const project = await adapter.projectGet(id);
      if (project === null) return reply.code(404).send({ error: `Project ${id} not found` });
      const ready = await queryable(adapter, id);
      if (!ready.ok) {
        const code = ready.status.state === 'engine-too-old' ? 501 : 404;
        return reply.code(code).send({ error: ready.status.detail, status: ready.status });
      }
      return reply.send(await projectSymbolSearch(ready, q.name.trim()));
    } catch (err) {
      return reply.code(graphErrorStatus(err)).send({ error: message(err) });
    }
  });
}
