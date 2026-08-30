---
name: crew-e2e-api-smoke
description: |
  The API layer every crew e2e script boots through, as a deterministic
  campaign scenario: daemon health answers with its version, a project is
  created over POST /api/v1/projects (namespaced fixture), and the list
  read reflects it. This is the PR-lane tripwire of the dogfood corpus —
  zero tokens, zero seats, machinery-verified ceiling.
version: "1.1"
category: api
tags: [e2e-corpus, qe-campaign, smoke, pr-deterministic]
isolation: stateless
tools:
  required: [curl, python3]
  optional: []
timeout: 60
assertions:
  - id: A1
    description: CREW_API is explicitly set — no default target, ever (isolated daemon only)
  - id: A2
    description: GET /health returns 200 with status ok and a daemon version
  - id: A3
    description: POST /projects creates a namespaced project (201) and GET /projects reads it back
---

## Setup

```bash
# Fixture namespace (the `stateless` contract): the qe runner provides
# QE_FIXTURE_NS per run; manual runs fall back to PID+time so two runs never
# collide. Persisted to a file because each step runs in its own shell.
WT_TMP="${TMPDIR:-${TEMP:-/tmp}}"
printf '%s' "${QE_FIXTURE_NS:-manual-$$-$(date +%s)}" > "${WT_TMP}/crew-e2e-api-smoke.ns"
```

## Steps

### Step 1: Refuse to run without an explicit isolated target (python3)

```bash
python3 -c "
import os, sys
api = os.environ.get('CREW_API', '')
if not api:
    sys.exit('CREW_API is unset - point it at an ISOLATED daemon (there is no default: the default would be somebody\\'s real daemon)')
print('target:', api)
"
```

**Expect**: Exit code 0, the isolated target printed; a naming error (exit 1) when CREW_API is unset

### Step 2: Daemon health answers with status ok + version (curl)

```bash
WT_TMP="${TMPDIR:-${TEMP:-/tmp}}"
rc=0
curl -sf "$CREW_API/health" -o "${WT_TMP}/crew-e2e-api-smoke-health.json" || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "health probe FAILED: $CREW_API unreachable (curl exit $rc) — the isolated daemon is not answering" >&2
  exit 1
fi
python3 -c "
import json, os
tmp = os.environ.get('TMPDIR') or os.environ.get('TEMP') or '/tmp'
d = json.load(open(os.path.join(tmp, 'crew-e2e-api-smoke-health.json')))
assert d.get('status') == 'ok', f'health status not ok: {d}'
assert d.get('version'), 'health carries no daemon version'
print('health ok, version', d['version'])
"
```

**Expect**: Exit code 0, `health ok, version <x.y.z>` printed; a NAMED probe failure (never a bare traceback) when the daemon is down

### Step 3: Create a namespaced project, HTTP 201 with an id (curl)

```bash
WT_TMP="${TMPDIR:-${TEMP:-/tmp}}"
QE_NS="$(cat "${WT_TMP}/crew-e2e-api-smoke.ns")"
curl -sf -X POST "$CREW_API/projects" \
  -H 'content-type: application/json' \
  -d "{\"name\": \"qe-smoke-$QE_NS\"}" \
  -o "${WT_TMP}/crew-e2e-api-smoke-project.json" -w "%{http_code}" | grep -q "^201$"
python3 -c "
import json, os
tmp = os.environ.get('TMPDIR') or os.environ.get('TEMP') or '/tmp'
d = json.load(open(os.path.join(tmp, 'crew-e2e-api-smoke-project.json')))
p = d.get('project', d)
assert p.get('id'), f'created project has no id: {d}'
print('created', p['id'])
"
```

**Expect**: Exit code 0, HTTP 201, the created project id printed

### Step 4: The list read reflects the created project (curl)

```bash
WT_TMP="${TMPDIR:-${TEMP:-/tmp}}"
QE_NS="$(cat "${WT_TMP}/crew-e2e-api-smoke.ns")"
curl -sf "$CREW_API/projects" | QE_NS="$QE_NS" python3 -c "
import json, os, sys
d = json.load(sys.stdin)
projects = d.get('projects', d if isinstance(d, list) else [])
name = 'qe-smoke-' + os.environ['QE_NS']
assert any(p.get('name') == name for p in projects), f'{name} missing from the list read'
print('read-back ok:', name)
"
```

**Expect**: Exit code 0, `read-back ok: qe-smoke-<ns>` printed

## Cleanup

```bash
WT_TMP="${TMPDIR:-${TEMP:-/tmp}}"
rm -f "${WT_TMP}/crew-e2e-api-smoke.ns" \
      "${WT_TMP}/crew-e2e-api-smoke-health.json" \
      "${WT_TMP}/crew-e2e-api-smoke-project.json"
```
