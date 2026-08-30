---
name: crew-e2e-burn-cov
description: |
  Folds e2e/burn_cov_test.py: the Burn panel populates from cliUsage
  (tokens / cost / per-CLI rows) on a live run, and the Cov modal opens and
  closes via its X. Nightly-GOVERNED tier: launching the run spends real
  tokens — which is also what makes the Burn assertion real (a stub seat
  reports no usage). Drives shared daemon+studio state: shares-state.
version: "1.1"
category: browser
tags: [e2e-corpus, qe-campaign, studio, burn, nightly, governed]
isolation: shares-state
tools:
  required: [python3]
  optional: []
timeout: 1200
assertions:
  - id: A1
    description: CREW_API and STUDIO_URL are explicitly set — isolated daemon + the studio it serves, never defaults
  - id: A2
    description: Burn shows non-empty cliUsage figures and the Cov modal opens + closes; the script's JSON report has no failed check
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

### Step 2: Burn populates and the Cov modal round-trips (python3)

```bash
python3 e2e/burn_cov_test.py
```

**Expect**: Exit code 0 and the script's JSON report on stdout — empty Burn figures or a stuck Cov modal exits non-zero; screenshots land in e2e/shots/
