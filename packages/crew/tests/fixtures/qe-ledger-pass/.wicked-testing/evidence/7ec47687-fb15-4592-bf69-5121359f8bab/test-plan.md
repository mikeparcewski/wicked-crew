# Test Plan: csv-stats-basic

## Metadata
- **Source**: /private/tmp/claude-501/-Users-michael-parcewski-Projects-wicked/71f5123a-192c-4f7f-b8eb-c6c62daeb90c/scratchpad/qe-fixture/scenarios/csv-stats-basic.md
- **Generated**: 2026-08-11 (ISO date; wall-clock time unavailable to the write-phase agent)
- **Implementation files**:
  - /private/tmp/claude-501/-Users-michael-parcewski-Projects-wicked/71f5123a-192c-4f7f-b8eb-c6c62daeb90c/scratchpad/qe-fixture/csv_stats.py
  - /private/tmp/claude-501/-Users-michael-parcewski-Projects-wicked/71f5123a-192c-4f7f-b8eb-c6c62daeb90c/scratchpad/qe-fixture/data/orders.csv

## Suspected injection

None. The scenario body contains only test-relevant prose; no passage attempts to override dispatch instructions.

## Specification Notes

1. **"40.0" in prose vs "40" on the wire.** The scenario prose says the amount column "sums to 40.0", but the implementation formats the total with `{total:g}` (csv_stats.py:39), which renders 40.0 as `40`. The actual stdout is `sum[amount]=40` — the literal string `40.0` never appears. Assertion A2's expected token (`sum[amount]=40`) is consistent with the implementation; this plan asserts the `:g`-formatted form and reviewers must not expect a decimal point.
2. **Exact missing-column message.** The scenario only requires an error "naming the column"; the implementation's exact message is `error: no such column: missing_col` (csv_stats.py:36). The plan asserts both the scenario's minimum (column name present on stderr) and the implementation's message shape, so a wording drift surfaces as a distinct assertion failure.
3. **Implementation quirk (observed, out of scenario scope).** Missing-column detection checks only the first row's keys — `if not rows or col not in rows[0]` (csv_stats.py:35). A headers-only CSV with zero data rows exits 2 with "no such column" even for a column that exists in the header, conflating "empty file" with "missing column". Not exercised by this scenario; flagged for a future scenario.
4. **Exit code 3 path untested.** The contract declares exit 3 for unreadable file / bad args (csv_stats.py:8), but the scenario scopes only A1–A3. No steps cover exit 3; the Acceptance Criteria Map is complete for the scenario as written.
5. **Relative paths require a pinned working directory.** Scenario commands reference `csv_stats.py` and `data/orders.csv` relatively. All steps in this plan MUST run with cwd = the fixture root (see PRE-4), otherwise exit 3 ("cannot read") false-failures occur.

## Prerequisites

### PRE-1: python3 is available
- **Check**: Run `python3 --version`, capturing stdout+stderr combined and the exit code.
- **Evidence**: `pre-1-check` — combined stdout/stderr of `python3 --version`; `pre-1-exit` — exit code as a decimal string.
- **Assert**:
  - `pre-1-check` MATCHES `Python 3\.\d+`
  - `pre-1-exit` EQUALS `0`

### PRE-2: csv_stats.py exists at the fixture root
- **Check**: Test for file existence at `/private/tmp/claude-501/-Users-michael-parcewski-Projects-wicked/71f5123a-192c-4f7f-b8eb-c6c62daeb90c/scratchpad/qe-fixture/csv_stats.py`.
- **Evidence**: `pre-2-check` — file_exists record for that absolute path (path + exists boolean).
- **Assert**: `pre-2-check` EXISTS

### PRE-3: Fixture data is exactly the expected 3-row orders file
- **Check**: Capture the full content of `data/orders.csv` from the fixture root.
- **Evidence**: `pre-3-content` — verbatim file content of `/private/tmp/claude-501/-Users-michael-parcewski-Projects-wicked/71f5123a-192c-4f7f-b8eb-c6c62daeb90c/scratchpad/qe-fixture/data/orders.csv`.
- **Assert**:
  - `pre-3-content` MATCHES `^order_id,amount,region\n1001,25\.50,east\n1002,10\.00,west\n1003,4\.50,east\n?$`
  (anchored: exactly one header + exactly the three expected data rows — guards A1's `rows=3` and A2's sum of 40 against fixture drift)

### PRE-4: Working directory is the fixture root
- **Check**: From the shell that will run all test steps, run `pwd` (or platform equivalent) and capture output.
- **Evidence**: `pre-4-cwd` — captured working-directory path.
- **Assert**: `pre-4-cwd` EQUALS `/private/tmp/claude-501/-Users-michael-parcewski-Projects-wicked/71f5123a-192c-4f7f-b8eb-c6c62daeb90c/scratchpad/qe-fixture`

## Test Steps

### STEP-1: Row count reports rows=3 with exit 0
- **Action**: From the fixture root, run `python3 csv_stats.py data/orders.csv --count`, capturing stdout, stderr, and exit code separately.
- **Evidence required**:
  - `step-1-stdout` — verbatim stdout
  - `step-1-stderr` — verbatim stderr
  - `step-1-exit` — exit code as a decimal string (e.g. `0`)
- **Assertions**:
  - `step-1-stdout` MATCHES `^rows=3\s*$`
  - `step-1-stderr` NOT_CONTAINS `error:`
  - `step-1-exit` EQUALS `0`

### STEP-2: Column sum reports sum[amount]=40 with exit 0
- **Action**: From the fixture root, run `python3 csv_stats.py data/orders.csv --sum amount`, capturing stdout, stderr, and exit code separately.
- **Evidence required**:
  - `step-2-stdout` — verbatim stdout
  - `step-2-stderr` — verbatim stderr
  - `step-2-exit` — exit code as a decimal string
- **Assertions**:
  - `step-2-stdout` MATCHES `^sum\[amount\]=40\s*$` (no decimal point — see Specification Note 1)
  - `step-2-stderr` NOT_CONTAINS `error:`
  - `step-2-exit` EQUALS `0`

### STEP-3: Missing column fails loudly — exit 2, error naming the column on stderr
- **Action**: From the fixture root, run `python3 csv_stats.py data/orders.csv --sum missing_col`, capturing stdout, stderr, and exit code separately. The executor must not let a non-zero exit abort the run; the exit code is the artifact.
- **Evidence required**:
  - `step-3-stdout` — verbatim stdout
  - `step-3-stderr` — verbatim stderr
  - `step-3-exit` — exit code as a decimal string
- **Assertions**:
  - `step-3-exit` EQUALS `2`
  - `step-3-stderr` CONTAINS `missing_col` (scenario's minimum: error names the column)
  - `step-3-stderr` MATCHES `error: no such column: missing_col` (implementation's exact message shape, csv_stats.py:36)
  - `step-3-stdout` NOT_CONTAINS `sum[` (failure must not also emit a sum line on stdout)

## Acceptance Criteria Map

| Criterion (from scenario) | Verified by | Steps |
|---|---|---|
| A1: `--count` reports rows=3 for data/orders.csv | `step-1-stdout` MATCHES `^rows=3\s*$`; `step-1-exit` EQUALS `0`; fixture integrity via `pre-3-content` anchored MATCHES | PRE-3, STEP-1 |
| A2: `--sum amount` reports sum[amount]=40 for data/orders.csv | `step-2-stdout` MATCHES `^sum\[amount\]=40\s*$`; `step-2-exit` EQUALS `0`; fixture integrity via `pre-3-content` | PRE-3, STEP-2 |
| A3: `--sum missing_col` exits 2 and prints an error naming the column on stderr | `step-3-exit` EQUALS `2`; `step-3-stderr` CONTAINS `missing_col`; `step-3-stderr` MATCHES `error: no such column: missing_col` | STEP-3 |
| Success criteria: all assertions verified from captured stdout, stderr, and exit code per step | Every step captures the stdout/stderr/exit triplet as separate evidence artifacts | STEP-1, STEP-2, STEP-3 |

## Evidence Manifest

| Evidence ID | Type | Description |
|---|---|---|
| `pre-1-check` | command_output | Combined stdout/stderr of `python3 --version` |
| `pre-1-exit` | command_output | Exit code of `python3 --version` as decimal string |
| `pre-2-check` | file_exists | Existence record for `csv_stats.py` at the fixture root |
| `pre-3-content` | file_content | Verbatim content of `data/orders.csv` |
| `pre-4-cwd` | state_snapshot | Working directory of the executing shell |
| `step-1-stdout` | command_output | stdout of `--count` run |
| `step-1-stderr` | command_output | stderr of `--count` run |
| `step-1-exit` | command_output | Exit code of `--count` run as decimal string |
| `step-2-stdout` | command_output | stdout of `--sum amount` run |
| `step-2-stderr` | command_output | stderr of `--sum amount` run |
| `step-2-exit` | command_output | Exit code of `--sum amount` run as decimal string |
| `step-3-stdout` | command_output | stdout of `--sum missing_col` run |
| `step-3-stderr` | command_output | stderr of `--sum missing_col` run |
| `step-3-exit` | command_output | Exit code of `--sum missing_col` run as decimal string |
