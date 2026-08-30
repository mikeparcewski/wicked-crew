# e2e/campaign — crew's own e2e suite as a qe campaign (the first dogfood corpus)

TH-23 (RECON-TEST-HARNESS test-R19): the operator scripts in [`e2e/`](../README.md)
folded into **campaign scenario format** — wicked-garden's scenario-format
v1.1 markdown bound by a `campaign-recon.json` plan (format v2). The scripts
stay the source of truth for *how* each journey is driven; the scenarios are
the campaign-consumable spec of *what each run must prove*, with explicit
isolation classes, claim ceilings, and tier tags.

## Layout

```
e2e/campaign/
  campaign-recon.json     # the persisted strategy (garden campaign-recon format v2)
  scenarios/              # scenario-format v1.1 files, one per folded script
```

Validate the plan any time with garden's fail-closed validator:

```bash
python3 <wicked-garden>/scripts/qe/campaign_plan.py validate e2e/campaign/campaign-recon.json
```

## The corpus (5 representative scripts folded)

| Scenario | Folds | Tier | Isolation |
|---|---|---|---|
| `crew-e2e-api-smoke` | the API layer every e2e script boots through (health → create project → read-back) | **pr-deterministic** — zero tokens | `stateless` (namespaced fixtures) |
| `crew-e2e-acp-handshake` | `acp-probe.mjs` | nightly (spends a prompt against a real adapter) | `stateless` |
| `crew-e2e-project-model` | `project_model_e2e.mjs` (DES-PROJECT-001 §8, all ten steps) | nightly | `exclusive` (fixed port 4491 + own scratch stack) |
| `crew-e2e-insight-rail` | `insight_rail_test.py` | nightly-governed (real run, real tokens) | `shares-state` |
| `crew-e2e-burn-cov` | `burn_cov_test.py` | nightly-governed (real run, real tokens) | `shares-state` |

Tags encode the CI split from garden's `skills/qe/refs/campaign-ci.md`:
`pr-deterministic` scenarios may run on every PR (executor claims only);
everything tagged `nightly` belongs in the governed, budget-capped,
flake-policied nightly lane (TH-20/TH-21 — see wicked-crew
`docs/campaign-budgets.md` for the knobs).

## Isolation is not optional

Every scenario here requires `CREW_API` (and the browser ones `STUDIO_URL`)
to point at an **isolated daemon** the operator/CI job booted itself:

```bash
node packages/crew/dist/cli/index.js serve --port 7941 \
  --db "$SCRATCH/core.db" --bus-db "$SCRATCH/bus.db"
export CREW_API="http://127.0.0.1:7941/api/v1"
```

The scenarios fail closed when `CREW_API` is unset — there is no default,
because the default would be somebody's real daemon. Scenarios that mutate
state namespace their fixtures with `QE_FIXTURE_NS` (the runner provides one
per run; set it yourself for manual runs).

## Running

- **Mechanically / CI**: each `### Step N` block is plain bash — exit 0 is
  PASS (the scenario-format step rule). The api-smoke scenario is the
  PR-lane tripwire.
- **Through garden's qe domain**: `wicked-garden-qe execute <scenario.md>`
  dispatches the scenario executor and records run + evidence in
  `.wicked-qe/`; grading goes through the accept trio (executor claims are
  never verdicts of record).
- **As a campaign**: the plan's rungs map onto `POST /api/v1/campaigns`
  `tool` nodes (file paths, never inline bodies — the 1022-byte rule), and
  `campaign-rerun.mjs --strategy e2e/campaign` diffs verdicts against the
  prior run from ledger history.

`environment_manifest.ref` points at the TH-8 preflight artifact, which is
**generated per run** next to the plan — committed here is the strategy,
never a stale environment claim.
