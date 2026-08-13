# DES-AUTH-001 — Team Profile: Identity & Auth Contract

**Product:** wicked-crew  
**Phase:** 8 — foundation team profile  
**Status:** IMPLEMENTED (workload tokens + actor model); OIDC seam designed, implementation tracked in crew#249  
**Depends on:** REQ-002 §technology-constraints (decision #6: OAuth/OIDC + workload tokens)

## 1. Problem

wicked-crew's daemon is local-first: in solo deployment the API is loopback-only
and all callers are implicitly trusted. A team deployment (shared Postgres,
multiple engineers + CI pipelines accessing the same crew instance) needs:

1. **Who** is acting — a stable authenticated identity, not a caller-supplied label.
2. **What they may do** — a minimal trust ladder (admin / operator / observer).
3. **Audit trail** — every privileged action recorded with the authenticated actor.

The constraint is zero config for local: the solo developer must not add a
credentials step. Identity works transparently in every mode; the trust model
merely varies.

## 2. The two deployment shapes

| | Local (default) | Team / hosted |
|---|---|---|
| Trigger | nothing — zero config | `WICKED_RUNTIME=team` or `WICKED_CREW_AUTH=required` |
| Bind / CORS | `127.0.0.1`, loopback origins only | any origin (or allowlist) |
| Token | none | `Authorization: Bearer <token>` on every `/api/v1` and `/ws` |
| Actor | implicit `{id:"local", kind:"human", trust:"admin"}` | resolved from the token |

**Local is sacred.** The zero-config deployment behaves exactly as before:
no token file read, no request denied. What changed is that every request now
*carries* an actor — the implicit full-trust local one — so downstream events
have ONE shape regardless of auth mode.

## 3. The actor model

Every request acts as an **actor**:

```json
{ "id": "maria", "kind": "human", "trust": "operator" }
```

- `id` — stable principal. Bus events (`wicked.crew.project.*`) carry the
  *authenticated* id, never a caller-supplied label (locked decision #6).
- `kind` — `human` | `agent` | `system` (see §4 below).
- `trust` — the rung the caller holds on the trust ladder.

### Trust ladder (three rungs, admin > operator > observer)

| Trust | May do |
|---|---|
| `observer` | Every read — all GETs, the `/ws` event stream, the audit trail. |
| `operator` | The work — launch/steer/cancel runs, answer gates and elicitations, open chats and terminals, register repos and workflows, project CRUD + membership. |
| `admin` | The governance surface — policy/rule writes and retirements, `PUT /settings`, project archive/restore. |

The implicit local actor is `admin` (one human, no useful boundary).

Default for unlisted routes: reads → `observer`, mutations → `operator`. One
body-dependent rule: `PATCH /projects/:id` is `operator` except when the patch
touches `status` (archive/restore) → `admin`.

### Deny semantics

- **401** — required mode and the request carries no token or a malformed
  `Authorization` header. Includes WS upgrades.
- **403** — valid token, but the actor is below the route's rung.
- CORS preflights (`OPTIONS`) answered before the token check.
- The SPA shell and static assets stay public (not under `/api/v1`).

## 4. Actor kinds

| Kind | Who | Notes |
|---|---|---|
| `human` | A person — local operator, or OIDC (once that seam lands; crew#249). | The implicit local actor is `human`. |
| `agent` | A workload — CI pipeline, a bot, another daemon. | Identified by a workload token in `tokens.json`. |
| `system` | An internal process — the wicked-core bus bridge, daemon-internal lifecycle emitters. | Distinguishable from workload agents in the audit trail. Declared at token config time. |

## 5. Workload tokens (v1 verifier — IMPLEMENTED)

Static bearer tokens mapped to actors in
`~/.config/wicked-crew/tokens.json` (override: `WICKED_CREW_TOKENS`).
**SHA-256 hashed at rest** — the file stores `sha256(token)`, never the token.

```json
{
  "tokens": [
    { "hash": "<sha256(bearer-value)>", "actor": { "id": "ci-pipeline", "kind": "agent", "trust": "operator" } }
  ]
}
```

The file is read once at boot; restart the daemon after editing.

Generating a token:

```bash
openssl rand -hex 32   # → BEARER_VALUE
printf '%s' BEARER_VALUE | sha256sum -   # → HASH for tokens.json
```

## 6. OIDC seam (DESIGNED, not yet implemented — crew#249)

OAuth/OIDC for humans is **designed but not implemented**. The pieces exist:

- `TokenVerifier` (`src/api/auth.ts`) — the pluggable interface all
  verification goes through. The static-token verifier implements it; the
  OIDC verifier will be a second implementation.
- `OidcConfig` in `~/.config/wicked-crew/auth.json`:
  ```json
  {
    "oidc": {
      "issuer": "https://idp.example.com",
      "audience": "wicked-crew",
      "jwksUri": "https://idp.example.com/.well-known/jwks.json",
      "claims": { "id": "sub", "trust": "wicked_trust" },
      "defaultTrust": "observer"
    }
  }
  ```
- Contract: bearer JWTs verified against the issuer's JWKS, `aud` against
  `audience`, `trust` from the claims (default `observer` — least privilege).

Configuring `oidc` today **fails the boot loudly** — a daemon must never
pretend an IdP was consulted.

## 7. Actor threading

Where identity lands downstream:

- **Audit trail** — one JSON line per privileged action in
  `~/.wicked-crew/audit.log` (override: `WICKED_CREW_AUDIT_LOG`), read by
  `GET /api/v1/audit`. Actions logged: `run.launched`, `gate.decided`,
  `run.cancelled`, `run.resumed`, `run.injected`, `elicitation.resolved`,
  `governance.policy.upserted|retired`, `governance.rule.upserted|retired`,
  `settings.updated`, `workflow.registered`, `project.created`,
  `project.archived`.
- **Bus events** — every `wicked.crew.project.*` event's `actor` field is the
  authenticated actor id.
- **Gate decisions** — `gate.decided` audit entry records who approved; the
  engine's `interaction_requests` row records *that* it resolved.

When wicked-core grows an actor field on `LaunchOptions`, the adapter threads
the same `Actor` through.

## 8. `WICKED_RUNTIME` × auth interaction

`WICKED_RUNTIME=team` is deny-dominant over `WICKED_CREW_AUTH=off` — a
deliberate safeguard:

```
WICKED_RUNTIME=team → auth 'required'   (always, even if WICKED_CREW_AUTH=off)
WICKED_CREW_AUTH=required → auth 'required'
WICKED_CREW_AUTH=off (without team) → auth 'off'
otherwise → auth 'off'
```

The CORS bind gates on auth mode: `required` → any origin (or allowlist);
`off` → loopback-only.

## 9. `GET /api/v1/whoami`

Answers the actor a request authenticated as, plus the daemon's auth mode —
the cheap probe a skin calls to decide what to render:

```json
{
  "actor": { "id": "maria", "kind": "human", "trust": "operator" },
  "authMode": "required"
}
```

## 10. Reference

- Implementation: `packages/crew/src/api/auth.ts`, `packages/crew/src/api/server.ts`
- Tests: `packages/crew/tests/auth.test.ts` (unit)
- User-facing doc: `docs/auth.md` (authoritative operator guide)
- Follow-up: OIDC implementation — crew#249
- Cross-reference: `wicked-estate/docs/team-runtime.md` (the Postgres-side of Phase 8)
