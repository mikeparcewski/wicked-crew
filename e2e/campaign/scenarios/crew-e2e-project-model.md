---
name: crew-e2e-project-model
description: |
  Folds e2e/project_model_e2e.mjs: DES-PROJECT-001 §8 verbatim — one project
  created in studio's API, continued in interactive, both reflecting the
  same state, across all ten numbered steps (boot, create, gated run
  auto-attach, durable prompt, RESTART SURVIVAL, continue in interactive,
  activity interleave + live /ws, gate answered from the creator skin,
  foundation record, offline regression). The script builds its own scratch
  stack (fresh core.db/bus, deterministic stub seat) — nothing touches real
  state — but it binds a FIXED interactive port (4491) and restarts its own
  daemon mid-run, so the scenario is exclusive: never overlap another rung.
version: "1.1"
category: cli
tags: [e2e-corpus, qe-campaign, project-model, nightly]
isolation: exclusive
tools:
  required: [node, npx]
  optional: []
timeout: 900
assertions:
  - id: A1
    description: wicked-interactive is present as a sibling checkout (or WICKED_INTERACTIVE_REPO) — declared, never guessed
  - id: A2
    description: all ten ADR §8 steps PASS — the script exits 0 only when every numbered assertion held
---

## Steps

### Step 1: The interactive dependency is declared and present (node)

```bash
node -e "
const { existsSync } = require('fs');
const { join, resolve } = require('path');
const root = process.env.WICKED_INTERACTIVE_REPO || resolve('..', 'wicked-interactive');
if (!existsSync(join(root, 'bin', 'wicked-interactive.js'))) {
  console.error('wicked-interactive not found at ' + root + ' - check it out as a sibling or set WICKED_INTERACTIVE_REPO');
  process.exit(1);
}
console.log('interactive:', root);
"
```

**Expect**: Exit code 0, the interactive root printed; exit 1 naming the missing dependency otherwise

### Step 2: The full ten-step journey passes on a scratch stack (npx)

```bash
npx tsx e2e/project_model_e2e.mjs
```

**Expect**: Exit code 0; ten `PASS  <n>. …` lines and a final JSON report — any failed numbered assertion exits non-zero
