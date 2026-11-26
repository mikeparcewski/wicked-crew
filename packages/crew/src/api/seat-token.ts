/**
 * The seat-token tripwire (F37 §6.4; crew#1890): a write that only the person may make refuses a request that carries
 * a governed unit's token, whatever the auth mode says.
 *
 * Under `auth: required` the bearer already proved who the caller is, and a unit token is no identity there (401), so
 * the route's own actor check is the gate. Under `auth: off` every caller is the local human, so a worker that SENDS its
 * token is caught here; one that omits it is the stated honest limit of auth off. Used by the editor writes (install,
 * removal, enable, grants) and every write to the daemon skills root.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Actor } from '../core/types.js';
import { LOCAL_ACTOR } from './auth.js';

/**
 * The engine's word on a bearer: `unit` (it names the unit), `not_unit` (it refused the token as `invalid_token:`), or
 * `unknown` (any other failure, or an answer without a unit): the tripwire then fails CLOSED, so a resolver fault never
 * waves a worker's token through (codex r1 on F37).
 */
export type UnitTokenVerdict = 'unit' | 'not_unit' | 'unknown';

/** Is this bearer a governed unit's token? */
export type UnitTokenProbe = (token: string) => Promise<UnitTokenVerdict>;

/** The bearer a request carries, if any (`Authorization: Bearer <token>`). */
export function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/iu.exec(h);
  return m === null ? null : m[1]!;
}

/** The probe over the engine's `resolveEstateScope` (a unit token names its unit); null resolver = no engine to ask. */
export function unitTokenProbe(resolve: ((requestJson: string) => Promise<string>) | null): UnitTokenProbe | undefined {
  if (resolve === null) return undefined;
  return async (token) => {
    let raw: string;
    try {
      raw = await resolve(JSON.stringify({ token }));
    } catch (err) {
      return /^invalid_token\b/u.test(err instanceof Error ? err.message : String(err)) ? 'not_unit' : 'unknown';
    }
    try {
      const unit = (JSON.parse(raw) as { unit?: { runId?: unknown } }).unit;
      return typeof unit?.runId === 'string' ? 'unit' : 'unknown';
    } catch {
      return 'unknown';
    }
  };
}

/**
 * Whether the request may go on past the tripwire. Only the local actor of auth off is checked (see the module note);
 * a request with no bearer is clear. Otherwise the reply is sent and false returned: 403 `seat_token` with `refusal`
 * for a unit's token, 503 when crew cannot tell (no probe, which means no engine to ask, or a probe fault or throw). Nothing is
 * logged of the token itself.
 */
export async function seatTokenClear(
  req: FastifyRequest,
  reply: FastifyReply,
  actor: Actor,
  probe: UnitTokenProbe | undefined,
  refusal: string,
  log?: (msg: string) => void,
): Promise<boolean> {
  const bearer = actor === LOCAL_ACTOR ? bearerOf(req) : null;
  if (bearer === null) return true;
  let verdict: UnitTokenVerdict = 'unknown';
  try {
    if (probe !== undefined) verdict = await probe(bearer);
  } catch {
    verdict = 'unknown'; // a probe that throws fails closed too (503), never a 500 (pi r1)
  }
  if (verdict === 'not_unit') return true;
  if (verdict === 'unit') {
    log?.(`refused ${req.method} ${req.routeOptions?.url ?? req.url}: the request carries a governed unit's token`);
    void reply.code(403).send({ code: 'seat_token', error: refusal });
    return false;
  }
  void reply.code(503).send({ error: "could not tell whether this request carries a governed worker's token, so nothing was changed; try again" });
  return false;
}
