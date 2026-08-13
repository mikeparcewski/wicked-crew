# Identity & auth: the actor contract on the wicked-crew API

wicked-crew's daemon has two deployment shapes, and they differ in exactly one
thing: whether a request must prove who it is.

| | **Local (the default)** | **Team / hosted** |
|---|---|---|
| Trigger | nothing — zero config | `WICKED_RUNTIME=team` or `WICKED_CREW_AUTH=required` |
| Bind / CORS | `127.0.0.1`, loopback origins only | any origin (or an allowlist) — see [CORS pairing](#cors-pairing) |
| Token | none | `Authorization: Bearer <token>` on every `/api/v1` and `/ws` request |
| Actor | implicit `{id:"local", kind:"human", trust:"admin"}` | resolved from the token |

**Local is sacred.** The zero-config solo deployment behaves exactly as it
always has: no token file is read, no request is denied, and the whole trust
model is the loopback bind. What changed is only that every request now
*carries* an actor — the implicit full-trust local one — so run provenance,
gate decisions, and bus events downstream have ONE shape whether or not auth
is on.

## The actor model

Every request under `/api/v1` and `/ws` acts as an **actor**:

```json
{ "id": "maria", "kind": "human", "trust": "operator" }
```

- `id` — a stable principal id. Replaces the free-text actor strings that any
  caller could spoof (locked decision #6): bus events
  (`wicked.crew.project.*`) and the audit trail now carry the *authenticated*
  id, never a caller-supplied label.
- `kind` — `human` (a person: local operator or an OIDC-authenticated user),
  `agent` (a workload: CI, a bot, another daemon), or `system` (an internal
  process actor: the wicked-core bus bridge, daemon-internal lifecycle emitters,
  and other principal-less system components that must be distinguishable from
  workload agents in the audit trail).
- `trust` — a rung on the ladder below.

`GET /api/v1/whoami` answers the actor a request authenticated as, plus the
daemon's auth mode — the cheap probe a skin calls to decide what to render.

### The trust ladder

Minimal by design: three rungs, `admin` > `operator` > `observer`.

| Trust | May do |
|---|---|
| `observer` | Every read: all GETs, the `/ws` event stream, the audit trail. |
| `operator` | The work: launch/steer/cancel runs, answer gates and elicitations, open chats and terminals, register repos and workflows, project CRUD and membership. |
| `admin` | The governance surface: policy/rule writes and retirements, `PUT /settings`, project **archive/restore**. |

Unlisted routes follow the default rule — reads need `observer`, mutations
need `operator` — so there is no per-route registry to drift. One rule is
body-dependent: `PATCH /projects/:id` is an `operator` rename/describe unless
the patch touches `status` (archive/restore), which is `admin`.

The implicit local actor is `admin`: a solo deployment has one human and no
boundary worth drawing between that human and the daemon.

### Deny semantics

- **401** — required mode, and the request carries no token, a malformed
  `Authorization` header, or a token no verifier recognizes. The response
  carries `WWW-Authenticate: Bearer` and a JSON `error` naming which of the
  two it was. This includes the `/ws` upgrade: a bad WS handshake fails as an
  HTTP 401, not a silent hang.
- **403** — the token was valid but the actor sits below the route's rung.
  The `error` names both the required and the held trust.
- CORS preflights (`OPTIONS`) are answered before the token check — browsers
  do not send `Authorization` on them.
- The SPA shell and its static assets stay public (they are not under
  `/api/v1`), so a hosted skin can load and *ask* for a token.

## Workload tokens (v1's verifier)

Static bearer tokens, mapped to actors in
`~/.config/wicked-crew/tokens.json` (override: `WICKED_CREW_TOKENS`).
**Hashed at rest** — the file stores `sha256(token)`, never the token:

```json
{
  "version": 1,
  "tokens": [
    {
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "actor": { "id": "ci-runner", "kind": "agent", "trust": "operator" },
      "label": "nightly CI"
    },
    {
      "sha256": "...",
      "actor": { "id": "bus-bridge", "kind": "system", "trust": "operator" },
      "label": "wicked-core bus bridge"
    }
  ]
}
```

Minting one:

```bash
TOKEN=$(openssl rand -hex 32)          # give this to the client
printf '%s' "$TOKEN" | shasum -a 256   # put this hex in tokens.json
```

Rules the loader enforces:

- A **malformed file or entry fails the daemon's boot**, loudly, naming the
  entry and field — a typo'd trust level must never silently lock someone out
  or half-demote them.
- A **missing file** in required mode boots with a loud warning and an empty
  set: every request 401s until tokens are registered (fail closed, but
  diagnosable).
- Duplicate hashes are rejected (two actors behind one token is ambiguity).
- The file should be `chmod 600`; the daemon warns when it is group/world
  accessible.
- The file is read once at boot — restart the daemon after editing it.

## The OIDC seam

OAuth/OIDC for humans is **implemented** (shipped in [wicked-crew#249](https://github.com/mikeparcewski/wicked-crew/issues/249)).
Configure it in `~/.config/wicked-crew/auth.json` (override: `WICKED_CREW_AUTH_CONFIG`):

```json
{
  "auth": "required",
  "oidc": {
    "issuer": "https://idp.example.com",
    "audience": "wicked-crew",
    "jwksUri": "https://idp.example.com/.well-known/jwks.json",
    "claims": { "id": "sub", "trust": "wicked_trust" },
    "defaultTrust": "observer"
  }
}
```

- **`issuer`** (required) — must match the `iss` claim in the JWT. Used for
  OIDC discovery (`{issuer}/.well-known/openid-configuration`) when `jwksUri`
  is not provided explicitly.
- **`audience`** (required) — checked against the JWT `aud` claim.
- **`jwksUri`** (optional) — skip OIDC discovery and fetch keys directly.
- **`claims.id`** (default `sub`) — JWT claim used as the actor `id`.
- **`claims.trust`** (optional) — JWT claim that maps to `observer` / `operator` /
  `admin`; values not in that set fall back to `defaultTrust`.
- **`defaultTrust`** (default `observer`) — trust assigned when no valid
  `claims.trust` value is present. Least-privilege default.

Supported algorithms: RS256/384/512, ES256/384/512, PS256/384/512.
JWKS keys are cached per issuer with a 5-minute TTL; an unknown `kid` triggers
one immediate re-fetch before failing.

The verifier sits behind `TokenVerifier` (`src/api/auth.ts`) — the same
pluggable interface the static-token verifier uses. No route or hook changes
are needed when switching from static tokens to OIDC.

## Actor threading: where the identity lands

The engine's `LaunchOptions` (wicked-core-ts 0.6.0) carries no actor field, so
actor provenance is recorded crew-side:

- **The audit trail** — one JSON line per privileged action in
  `~/.wicked-crew/audit.log` (override: `WICKED_CREW_AUDIT_LOG`), read back by
  `GET /api/v1/audit` (`?runId=` / `?action=` / `?limit=`, newest first).
  Recorded actions: `run.launched`, `gate.decided` (including approve-via-resume),
  `run.cancelled`, `run.resumed`, `run.injected`, `elicitation.resolved`,
  `governance.policy.upserted|retired`, `governance.rule.upserted|retired`,
  `settings.updated`, `workflow.registered`, `project.created`,
  `project.archived`. Appends are loud-non-fatal: an unwritable trail never
  turns a valid gate approval into a 500, but it is said, not swallowed.
- **Bus events** — every `wicked.crew.project.*` emit's `actor` field is the
  authenticated actor id (the attaching *surface* — studio/interactive/cli/api
  — still rides separately where it always did).
- **Gate decisions** — "who approved" is the `gate.decided` audit entry; the
  engine's durable `interaction_requests` row records *that* the gate resolved,
  the trail records *who*.

When the engine grows an actor field on `LaunchOptions`, the adapter threads
the same `Actor` through — the shape is already the wire contract's
(`wicked-crew-api-types`: `Actor`, `TrustLevel`, `AuditEntry`, `WhoAmI`).

## CORS pairing

CORS beyond the machine is allowed **exactly when auth is required** — the R2
gap's fix. In local mode only loopback origins (`http://127.0.0.1:*`,
`http://localhost:*`) are reflected, as before. In required mode any origin is
reflected (bearer auth carries no ambient credential — a foreign page without
a token holds nothing), and `WICKED_CREW_ALLOWED_ORIGINS` (comma-separated)
narrows that to an allowlist. `Authorization` is in
`Access-Control-Allow-Headers` so browser skins can send the token.

## WebSockets

`/ws` and `/ws/terminals/:id` sit behind the same boundary. The upgrade
request authenticates via `Authorization: Bearer` — or, because the browser
`WebSocket` constructor cannot set headers, via `?access_token=<token>`
(RFC 6750 §2.3; the header wins when both are present, and the query form is
accepted **only** on the WS paths). A missing/bad token fails the upgrade with
HTTP 401.

## Env reference

| Variable | Effect |
|---|---|
| `WICKED_RUNTIME=team` | Forces auth required (deny-dominant — an explicit `WICKED_CREW_AUTH=off` cannot override it). |
| `WICKED_CREW_AUTH` | `required` \| `off` (default `off`). Any other value fails the boot. |
| `WICKED_CREW_TOKENS` | Token file path (default `~/.config/wicked-crew/tokens.json`). |
| `WICKED_CREW_AUTH_CONFIG` | auth.json path (default `~/.config/wicked-crew/auth.json`). |
| `WICKED_CREW_ALLOWED_ORIGINS` | Comma-separated CORS allowlist for required mode (default: any origin). |
| `WICKED_CREW_AUDIT_LOG` | Audit trail path (default `~/.wicked-crew/audit.log`). |

The daemon's readiness line reports the resolved mode:
`WICKED_CREW_READY {"mode":"serve", …, "auth":"required"}`.
