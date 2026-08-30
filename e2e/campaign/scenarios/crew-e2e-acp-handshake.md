---
name: crew-e2e-acp-handshake
description: |
  Folds e2e/acp-probe.mjs: one full ACP handshake (initialize → session/new
  → session/prompt with a real sessionId) against the adapter binary named
  by ACP_BINARY. Proves the bridge protocol leg end to end — the probe
  exits 0 only when the prompt round-trips. Nightly tier: the prompt spends
  real tokens against a real adapter, so this never runs on PRs.
version: "1.1"
category: cli
tags: [e2e-corpus, qe-campaign, acp, nightly]
isolation: stateless
tools:
  required: [node]
  optional: []
timeout: 180
assertions:
  - id: A1
    description: ACP_BINARY is explicitly declared — the scenario never guesses an adapter
  - id: A2
    description: initialize → session/new → session/prompt completes; probe exit 0 (error reply or 120s stall exits non-zero)
---

## Steps

### Step 1: Refuse to run without a declared adapter binary (node)

```bash
node -e "
const bin = process.env.ACP_BINARY || '';
if (!bin) {
  console.error('ACP_BINARY is unset - name the adapter binary explicitly (e.g. codex-acp); the scenario never guesses');
  process.exit(1);
}
console.log('adapter:', bin);
"
```

**Expect**: Exit code 0, the adapter binary printed; exit 1 with the naming error when unset

### Step 2: Full handshake round-trips through the adapter (node)

```bash
node e2e/acp-probe.mjs "$ACP_BINARY"
```

**Expect**: Exit code 0 — `initialize ok`, a `session:` id, and a `prompt result:` line printed; exit 1 on a session/prompt error, exit 2 on spawn failure or the probe's 120s timeout
