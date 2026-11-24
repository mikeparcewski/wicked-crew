/**
 * Snooze a Needs-you item (crew#1124, DES-desk-v2 §6 item 6).
 *
 *   GET    /api/v1/desk/snoozes        → { snoozes: DeskSnooze[] } (the ones still in force)
 *   PUT    /api/v1/desk/snoozes/:key   { until, severity? } → DeskSnooze; audited `desk.need.snoozed`
 *   DELETE /api/v1/desk/snoozes/:key   → { key, woken }; audited `desk.need.woken` when one was in force
 *
 * The key is the skin's own id for the item (studio's need-row key, `infra:disk`, `run:<id>`): opaque here. A snooze
 * only DEFERS an item on the Desk: every need is still in `/system.attention[]`, and the skin brings a snoozed item
 * back when its time passes or it gets worse (`severity` is what the person saw when they snoozed it).
 *
 * One mechanism for durability: the audit trail. The snoozes are folded from the trail's `desk.need.*` entries of the
 * last {@link DESK_SNOOZE_MAX_MS} at first use and kept in memory after it (this daemon is the trail's only writer),
 * so a snooze survives a restart and adds no state-home entry. Setting or ending one is a human operator's: an agent
 * must never be able to hide a need from the person it waits on.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor, DeskSnooze, DeskSnoozesResponse, DeskSnoozeWakeResponse } from 'wicked-crew-api-types';

import { z } from '../zod.js';
import { API_PREFIX } from './api-prefix.js';
import type { AuditLog } from './audit.js';
import { LOCAL_ACTOR } from './auth.js';
import { isHumanOperator } from './watch-routes.js';

const V = API_PREFIX;

/** The longest a need can be snoozed: a week. */
export const DESK_SNOOZE_MAX_MS = 7 * 24 * 3_600_000;
/** Under the server's 256-character path-parameter bound (server.ts `maxParamLength`). */
export const DESK_SNOOZE_KEY_MAX = 200;
export const DESK_SNOOZED = 'desk.need.snoozed';
export const DESK_WOKEN = 'desk.need.woken';

export const PutDeskSnoozeSchema = z.strictObject({
  until: z.iso.datetime({ offset: true }),
  severity: z.enum(['red', 'yellow']).optional(),
});

export class DeskSnoozes {
  private map: Map<string, DeskSnooze> | null = null;
  private loading: Promise<Map<string, DeskSnooze>> | null = null;

  constructor(
    private readonly audit: Pick<AuditLog, 'readAll'>,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<Map<string, DeskSnooze>> {
    if (this.map !== null) return this.map;
    this.loading ??= (async () => {
      const since = this.now() - DESK_SNOOZE_MAX_MS;
      const entries = (await this.audit.readAll({ since })).filter((e) => e.action === DESK_SNOOZED || e.action === DESK_WOKEN);
      const map = new Map<string, DeskSnooze>();
      for (const e of entries.reverse()) {
        const k = e.detail?.['key'];
        if (typeof k !== 'string') continue;
        if (e.action === DESK_WOKEN) {
          map.delete(k);
          continue;
        }
        const until = e.detail?.['until'];
        const severity = e.detail?.['severity'];
        if (typeof until !== 'string' || !Number.isFinite(Date.parse(until))) continue;
        map.set(k, { key: k, until, severity: severity === 'red' || severity === 'yellow' ? severity : null, at: new Date(e.ts).toISOString(), by: e.actor.id });
      }
      this.map = map;
      return map;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** The snoozes still in force, soonest to end first. */
  async list(): Promise<DeskSnooze[]> {
    const map = await this.load();
    const now = this.now();
    for (const [k, s] of map) if (Date.parse(s.until) <= now) map.delete(k);
    return [...map.values()].sort((a, b) => Date.parse(a.until) - Date.parse(b.until) || a.key.localeCompare(b.key));
  }

  async snooze(key: string, until: string, severity: 'red' | 'yellow' | null, actor: Actor, record: (s: DeskSnooze) => void): Promise<DeskSnooze> {
    const map = await this.load();
    const s: DeskSnooze = { key, until: new Date(Date.parse(until)).toISOString(), severity, at: new Date(this.now()).toISOString(), by: actor.id };
    record(s);
    map.set(key, s);
    return s;
  }

  /** Ends a snooze in force; `false` when there was none. */
  async wake(key: string): Promise<boolean> {
    const map = await this.load();
    const s = map.get(key);
    if (s === undefined) return false;
    map.delete(key);
    return Date.parse(s.until) > this.now();
  }

  /** The bound a PUT is judged against. */
  nowMs(): number {
    return this.now();
  }
}

export interface DeskSnoozeRouteDeps {
  snoozes: DeskSnoozes;
  audit: Pick<AuditLog, 'record'>;
}

export function registerDeskSnoozeRoutes(app: FastifyInstance, deps: DeskSnoozeRouteDeps): void {
  const actorOf = (req: FastifyRequest): Actor => (req as { actor?: Actor }).actor ?? LOCAL_ACTOR;
  const refusal = (actor: Actor): { error: string; code: string } | null =>
    isHumanOperator(actor) ? null : { error: `Snoozing a need is a person's choice (you are ${actor.kind}/${actor.trust}).`, code: 'human_operator_only' };
  const keyProblem = (key: string): string | null =>
    key.trim() === '' ? 'the item key is empty' : key.length > DESK_SNOOZE_KEY_MAX ? `the item key is over ${DESK_SNOOZE_KEY_MAX} characters` : null;

  app.get(`${V}/desk/snoozes`, { config: { manifest: { responseType: 'DeskSnoozesResponse', statusCodes: [200] } } }, async (): Promise<DeskSnoozesResponse> => ({
    snoozes: await deps.snoozes.list(),
  }));

  app.put<{ Params: { key: string } }>(
    `${V}/desk/snoozes/:key`,
    { config: { manifest: { requestType: 'PutDeskSnoozeBody', responseType: 'DeskSnooze', statusCodes: [200, 400, 403] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      const refused = refusal(actor);
      if (refused !== null) return reply.code(403).send(refused);
      const bad = keyProblem(req.params.key);
      if (bad !== null) return reply.code(400).send({ error: `Cannot snooze it: ${bad}.`, code: 'desk_snooze_invalid' });
      const parsed = PutDeskSnoozeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Send {"until": "<ISO time>"} and, optionally, "severity": "red" | "yellow".', code: 'desk_snooze_invalid' });
      }
      const until = Date.parse(parsed.data.until);
      const now = deps.snoozes.nowMs();
      if (until <= now) return reply.code(400).send({ error: 'The snooze must end in the future.', code: 'desk_snooze_invalid' });
      if (until - now > DESK_SNOOZE_MAX_MS) return reply.code(400).send({ error: 'A need can be snoozed for a week at most.', code: 'desk_snooze_invalid' });
      return deps.snoozes.snooze(req.params.key, parsed.data.until, parsed.data.severity ?? null, actor, (s) =>
        deps.audit.record(DESK_SNOOZED, actor, { detail: { key: s.key, until: s.until, severity: s.severity } }),
      );
    },
  );

  app.delete<{ Params: { key: string } }>(
    `${V}/desk/snoozes/:key`,
    { config: { manifest: { responseType: 'DeskSnoozeWakeResponse', statusCodes: [200, 400, 403] } } },
    async (req, reply): Promise<DeskSnoozeWakeResponse | typeof reply> => {
      const actor = actorOf(req);
      const refused = refusal(actor);
      if (refused !== null) return reply.code(403).send(refused);
      const bad = keyProblem(req.params.key);
      if (bad !== null) return reply.code(400).send({ error: `Cannot wake it: ${bad}.`, code: 'desk_snooze_invalid' });
      const woken = await deps.snoozes.wake(req.params.key);
      if (woken) deps.audit.record(DESK_WOKEN, actor, { detail: { key: req.params.key } });
      return { key: req.params.key, woken };
    },
  );
}
