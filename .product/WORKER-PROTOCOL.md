---
name: WORKER-PROTOCOL
title: wicked-crew — Worker Output Protocol
status: draft
version: 0.1
date: 2026-07-07
author: michael.parcewski@accenture.com
review-required: false
---

# Worker Output Protocol

This document defines the contract between wicked-crew and worker CLIs. Workers do not need to know they are being orchestrated by wicked-crew — they receive a prompt and produce output. This protocol describes how that output is structured and interpreted.

---

## 1. Dispatch Mechanism

wicked-crew spawns workers as subprocesses:

```
<worker-command> <worker-args> "<prompt>"
```

Examples:
```bash
claude --print "You are in the test-strategy phase. Context: {...}. Task: produce a test strategy. Output: see schema below."
codex run "task text here"
npx wicked-testing run plan.json
```

- Prompt is always the last argument (or the sole argument for stdin-mode workers)
- Workers receive context (prior phase artifacts) embedded in the prompt text
- Workers do NOT receive any wicked-crew-specific flags or environment variables

---

## 2. Structured Mode (preferred)

Workers SHOULD emit a JSON object to stdout as their final line:

```json
{
  "status": "ok",
  "artifact": { /* phase-specific content — see §4 */ },
  "reasoning": "optional — why this output was produced",
  "warnings": ["optional — non-blocking issues"],
  "votes": { /* required in council mode — see §3 */ }
}
```

Rules:
- The JSON MUST be the last line of stdout
- Everything before the last line is treated as reasoning/log noise and captured but not parsed
- `status` MUST be `"ok"` or `"error"`
- If status is `"error"`, wicked-crew records the full output as evidence and marks the dispatch as failed

---

## 3. Council Mode Output

When wicked-crew dispatches a council (multiple workers, same prompt), the prompt includes an explicit instruction: "You MUST include a `votes` object in your JSON output for council evaluation."

```json
{
  "status": "ok",
  "artifact": { /* ... */ },
  "votes": {
    "recommendation": "option-a",   /* or "option-b", "neutral", "escalate" */
    "confidence": 0.85,             /* 0.0 to 1.0 — informational only in v1; displayed to human but not used in synthesis arithmetic */
    "rationale": "string",          /* required */
    "dimensions": {
      /* key: assessment-dimension, value: "agree"|"disagree"|"uncertain" */
      "feasibility": "agree",
      "risk": "disagree",
      "alignment_with_goal": "agree"
    }
  }
}
```

**Council synthesis is deterministic** — no LLM call:

1. For each dimension, count how many workers said "agree", "disagree", "uncertain"
2. `dimension_agreement[d] = max_count / total_workers` (fraction of workers that agreed on the dominant answer)
3. `council_synthesis_score = mean(dimension_agreement[all dimensions])`
4. `council_consensus` governance policy: `council_synthesis_score >= threshold` (default 0.7)
5. `recommendation_agreement = fraction of workers with same recommendation`

Synthesis is purely arithmetic. No model call on the synthesis step.

---

## 4. Unstructured Mode (fallback)

If the worker does not emit valid JSON as its last line, wicked-crew applies an extraction pass:

1. Capture all stdout
2. Try to find a JSON object in the last 20 lines via regex
3. If found: parse as the artifact
4. If not found: store the full stdout as a raw text artifact with `kind: "raw-text"`

Raw-text artifacts satisfy `evidence-required` governance policies only if the policy allows `"raw-text"` in its required kinds. Policies requiring `"worker-output"` (structured) will fail on raw-text evidence.

---

## 5. Exit Codes

| Exit code | Meaning |
|---|---|
| 0 | Success — output is recorded as evidence |
| Non-zero | Error — full output captured as error evidence; dispatch marked failed |
| Timeout | wicked-crew sends SIGTERM after timeout; stdout captured at point of kill; dispatch marked timeout |

---

## 6. Timeout Handling

- Default timeout: 120 seconds (configurable per worker in workers.json)
- On timeout: SIGTERM sent, then SIGKILL after 5 seconds (POSIX). On Windows, execa's `forceKillAfterDelay` is used — semantically equivalent; implementation uses execa's cross-platform termination, not raw signals.
- Output captured at point of kill, stored as evidence with `status: "timeout"`
- Timeout is NOT a daemon crash — governance policy `worker-exit-success` will fail, blocking the gate

---

## 7. Phase-Specific Artifact Schemas

These are the expected `artifact` structures per phase in the built-in `feature` workflow:

```json
// clarify phase
{
  "acceptance_criteria": [{"id": "AC-001", "text": "..."}],
  "raid_items": [{"kind": "risk", "title": "...", "description": "..."}],
  "constraints": ["..."],
  "out_of_scope": ["..."]
}

// design phase
{
  "approach": "string",
  "components": [{"name": "...", "responsibility": "..."}],
  "decisions": [{"id": "DEC-001", "decision": "...", "rationale": "..."}],
  "risks": [{"title": "...", "mitigation": "..."}]
}

// test-strategy phase
{
  "scenarios": [{"id": "TS-001", "description": "...", "acceptance_criteria": ["AC-001"]}],
  "coverage_gaps": ["..."]
}

// build phase — wicked-testing verdict used directly
// test phase — wicked-testing verdict used directly
```

Artifact schemas for custom workflow types are defined in the workflow type YAML.

---

## 8. Protocol Versioning

The prompt includes a protocol version hint: `"Output format: wicked-crew worker protocol v1"`. Workers can use this to adapt output format if needed. wicked-crew v1 parses protocol v1 only.
