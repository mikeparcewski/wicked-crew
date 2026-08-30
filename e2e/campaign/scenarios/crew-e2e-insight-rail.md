---
name: crew-e2e-insight-rail
description: |
  Folds e2e/insight_rail_test.py: launch a run via the API, hold the studio
  page open while it executes (the insight rail builds from live WS events —
  no replay for late joiners), then open every accordion (What/Where,
  Decisions, Governance, Burn, Data, Steering, Assumptions, Files) plus the
  Term modal, screenshotting each. Nightly-GOVERNED tier: it launches a real
  governed run and spends real tokens; the page-hold makes it long. Drives
  shared daemon+studio state, so shares-state — serialized against every
  other scenario on the same instance.
version: "1.1"
category: browser
tags: [e2e-corpus, qe-campaign, studio, insight-rail, nightly, governed]
isolation: shares-state
tools:
  required: [python3]
  optional: []
timeout: 1800
assertions:
  - id: A1
    description: CREW_API and STUDIO_URL are explicitly set — isolated daemon + the studio it serves, never defaults
  - id: A2
    description: every insight-rail accordion and the Term modal renders populated on a live run; the script's JSON report has no failed section
---

## Steps

### Step 1: Refuse to run without explicit isolated endpoints (python3)

```bash
python3 -c "
import os, sys
missing = [k for k in ('CREW_API', 'STUDIO_URL') if not os.environ.get(k)]
if missing:
    sys.exit('unset: ' + ', '.join(missing) + ' - point both at the ISOLATED stack this run boots (never defaults)')
print('api:', os.environ['CREW_API'], 'studio:', os.environ['STUDIO_URL'])
"
```

**Expect**: Exit code 0, both endpoints printed; exit 1 naming what is unset otherwise

### Step 2: Every rail surface populates on a live run (python3)

```bash
python3 e2e/insight_rail_test.py
```

**Expect**: Exit code 0 and the script's JSON report on stdout — a missing/empty accordion, Term modal failure, or run-launch failure exits non-zero; screenshots land in e2e/shots/
