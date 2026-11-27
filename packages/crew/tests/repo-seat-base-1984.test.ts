// crew#1984 (wicked-core#2023, core#1043 part 3): `PUT /api/v1/repos/:id/seat-base` sets or clears a repo's own seat
// base image through the engine's single writer, and answers with the engine's updated entry.
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreAdapter } from '../src/core/adapter.js';
import type { RepoEntry } from '../src/core/types.js';
import { registerRoutes } from '../src/api/routes.js';
import { AuditLog } from '../src/api/audit.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { withRunViews } from './support/run-views.js';
import { removeScratch } from './setup/scratch.js';

let adapter: CoreAdapter;
let dir: string;
let app: FastifyInstance | undefined;
let core: Record<string, unknown>;

/** The engine's `RepoEntry` as `Core::list_repos` / `set_repo_seat_base_image` serialize it (wicked-core
 *  `src/repo.rs`, `RepoEntry`: `seat_layers_off` and `seat_base_image` are skipped when empty or unset;
 *  `seat_layers` rows are `{id, enabled, off_by}` from `seat_layers::rows`). */
function engineEntry(base: string | null): Record<string, unknown> {
  return {
    id: 'shop',
    name: 'shop',
    root_path: '/repos/shop',
    default_branch: 'main',
    registered_at: 0,
    graph_key: 'shop-1a2b3c',
    code_graph_db: '/state/repo-graphs/shop-1a2b3c/estate.db',
    findings: [],
    seat_layers: [{ id: 'go', enabled: base === null, off_by: base === null ? null : 'repo_base' }],
    ...(base === null ? {} : { seat_base_image: base }),
  };
}

/** wicked-core `container_floor::valid_image_ref`'s refusal, as `set_seat_base_image` raises it. */
const refusal = (image: string) =>
  `\`${image}\` is not a seat base image reference: use a local image name such as \`wicked-seat-base:rust\` ` +
  '(lowercase letters, digits and . _ / : @ -, starting with a letter or digit, at most 255 characters)';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-1984-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  core = (adapter as unknown as { core: Record<string, unknown> }).core;
  adapter.sessionsDetail = vi.fn(async () => []);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  adapter.close();
  removeScratch(dir);
});

/** A fake engine holding one repo; `setRepoSeatBaseImage` behaves as the engine's single writer does. */
async function serve() {
  let base: string | null = null;
  const set = vi.fn(async (id: string, image?: string | null) => {
    if (id !== 'shop') throw new Error(`no registered repo \`${id}\``);
    const next = typeof image === 'string' && image.trim() !== '' ? image.trim() : null;
    if (next !== null && !/^[a-z0-9][a-z0-9._/:@-]{0,254}$/u.test(next)) throw new Error(refusal(next));
    base = next;
    return JSON.stringify(engineEntry(base));
  });
  core['setRepoSeatBaseImage'] = set;
  adapter.listRepos = async () => [engineEntry(base) as unknown as RepoEntry];
  adapter.listWorkflows = () => [];
  const audit = AuditLog.noop();
  const record = vi.spyOn(audit, 'record');
  app = Fastify({ logger: false });
  registerRoutes(app, withRunViews(adapter), new GateCache(), new ElicitationCache(), undefined, { audit, authMode: 'off' });
  await app.ready();
  const put = (id: string, body: unknown) => app!.inject({ method: 'PUT', url: `/api/v1/repos/${id}/seat-base`, payload: body as object });
  return { app, set, record, put };
}

describe('PUT /repos/:id/seat-base (crew#1984)', () => {
  it("sets the base and answers with the engine's post-write entry, which GET /repos then shows", async () => {
    const { app, set, record, put } = await serve();
    const res = await put('shop', { image: 'acme/seat-base:go' });
    expect(res.statusCode).toBe(200);
    expect(set).toHaveBeenCalledWith('shop', 'acme/seat-base:go');
    expect(res.json()).toMatchObject({
      id: 'shop',
      seat_base_image: 'acme/seat-base:go',
      seat_layers: [{ id: 'go', enabled: false, off_by: 'repo_base' }],
    });
    expect(record).toHaveBeenCalledWith('repo.seat_base_set', expect.anything(), {
      detail: { repoId: 'shop', image: 'acme/seat-base:go' },
    });
    // STALE READS: the list is read from the engine on each GET, so it never answers older than the write.
    const listed = (await app.inject('/api/v1/repos')).json() as { repos: RepoEntry[] };
    expect(listed.repos[0]).toMatchObject({ seat_base_image: 'acme/seat-base:go' });
  });

  it.each([[null], [''], ['   ']])('clears the base with %j', async (image) => {
    const { set, put } = await serve();
    await put('shop', { image: 'acme/seat-base:go' });
    const res = await put('shop', { image });
    expect(res.statusCode).toBe(200);
    expect(set).toHaveBeenLastCalledWith('shop', null);
    expect(res.json()).not.toHaveProperty('seat_base_image');
    expect(res.json().seat_layers).toEqual([{ id: 'go', enabled: true, off_by: null }]);
  });

  it.each([
    ['no image', {}],
    ['a number', { image: 5 }],
    ['an extra key', { image: 'acme/base:go', pull: true }],
    ['an over-long reference', { image: 'a'.repeat(256) }],
  ])('refuses a body with %s before asking the engine', async (_what, body) => {
    const { set, record, put } = await serve();
    const res = await put('shop', body);
    expect(res.statusCode).toBe(400);
    expect(set).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it.each(['--privileged', 'acme base', '<b>x</b>', 'Acme/Base'])(
    "answers the engine's refusal of %j as 400 seat_base_invalid in its words, and writes nothing",
    async (image) => {
      const { app, record, put } = await serve();
      await put('shop', { image: 'acme/seat-base:go' });
      record.mockClear();
      const res = await put('shop', { image });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(/^application\/json/u);
      expect(res.json()).toEqual({ code: 'seat_base_invalid', error: refusal(image) });
      expect(record).not.toHaveBeenCalled();
      // PARTIAL FAILURE: the stored base is the one before the refused request.
      const listed = (await app.inject('/api/v1/repos')).json() as { repos: RepoEntry[] };
      expect(listed.repos[0]).toMatchObject({ seat_base_image: 'acme/seat-base:go' });
    },
  );

  it("answers an unknown repo as 404 repo_not_found (the engine's refusal)", async () => {
    const { set, put } = await serve();
    const res = await put('gone', { image: 'acme/seat-base:go' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'repo_not_found', error: 'no registered repo `gone`' });
    expect(set).toHaveBeenCalledWith('gone', 'acme/seat-base:go');
  });

  it('an engine without the binding is a typed 501, never a simulated write', async () => {
    const { app, put } = await serve();
    core['setRepoSeatBaseImage'] = undefined;
    const res = await put('shop', { image: 'acme/seat-base:go' });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'repo_seat_base_unsupported' });
    const listed = (await app.inject('/api/v1/repos')).json() as { repos: RepoEntry[] };
    expect(listed.repos[0]).not.toHaveProperty('seat_base_image');
  });
});
