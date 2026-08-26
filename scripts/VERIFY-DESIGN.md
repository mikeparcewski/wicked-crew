# verify-ecosystem: the contract

Written after nine review rounds of patching individual findings. Recon showed why they kept
coming: **2 of 10 external dependencies were guarded** — `diff` and `timeout`, the exact two a
reviewer had pointed at. `npm`, `curl`, `tar`, `git`, `node`, `mktemp`, `awk`, `grep` carried the
identical defect and were simply unvisited. Patching what gets flagged finds one hole per round
forever; the fix is a contract every check is held to, and a structure that makes violating it hard.

## What this tool is for

It re-derives "done" for the wicked-* ecosystem from evidence — what npm serves, what a published
tarball contains, what a live site returns, what an installed binary reports. Nothing here trusts a
green CI badge, a version in a manifest, or a claim in a doc; each of those has been wrong at least
once, and each wrong one is a named check because of it.

## Blast radius

It has no code consumers — it is an *instrument*, and its output is what a person (or an agent)
points at to claim the ecosystem is sound. So its failure modes are judgment failures:

| failure | consequence |
|---|---|
| false PASS | "done" is reported about something broken — **silent**, the worst outcome |
| false FAIL | noise; people learn to ignore the tool, and then it protects nothing |
| hang | no verdict at all, and nothing reports the absence |

A false PASS is worse than a false FAIL, and both are worse than an honest SKIP.

## Invariants

Every check must satisfy all six. These are the review checklist; a new check is not done until
each is answered.

- **I1 — Verdicts come from evidence.** `ok` and `bad` may only be emitted about the ecosystem.
  Anything else is `skip`.
- **I2 — The local environment is never a verdict.** A missing tool, absent network, unreadable
  git ref, or unavailable checkout is `skip` with the reason. This is the invariant that was
  violated three separate times (npm, the site check, `diff`).
- **I3 — Registry input is hostile.** Anything downloaded is validated before use: member paths,
  member types, and no execution of its lifecycle scripts.
- **I4 — Bounded.** Every external run has a deadline. A verifier that never returns is worse than
  one that returns wrong, because nothing reports it.
- **I5 — Read-only.** It inspects; it never mutates the ecosystem. Writes go to a temp dir it owns
  and removes.
- **I6 — Absence of evidence is not evidence of absence.** "I could not check" never renders as a
  pass.

## Structure that enforces them

1. **One gate, not ten scattered guards.** Every check declares its tools in a single `need ...`
   call, which probes them with the `command -v` builtin and skips with a named reason when any is
   absent. The decision lives in one place per check rather than at each call site — which is how
   eight of them got missed. (An earlier draft memoized the probe into an associative array; that
   is bash 4, and macOS ships 3.2, so it is deliberately an on-demand builtin probe instead.)
2. **`bad` is reachable only after evidence is in hand.** Fetch/parse/tooling failures return early
   via `skip`, so the verdict path cannot be entered without data.
3. **Untrusted extraction goes through one function** (`safe_untar`), allowlisting member types
   (`-`, `d`) and rejecting absolute paths and `..` segments per segment.
4. **Every bounded run goes through one function** (`run_bounded`), which uses `timeout`/`gtimeout`
   when present and a shell watchdog when not — never unbounded.
5. **A helper gates its own dependencies.** `run_bounded`'s watchdog needs `mktemp`/`cat`/`rm`/
   `sleep`; `safe_untar` needs `tar`/`awk`. Those are checked inside the helper, which returns a
   distinguishable code (125 for "cannot bound") that callers translate to a skip. The alternative
   — every check listing a helper's internal tools in its own `need` — couples callers to
   implementation details and re-creates the scattered-guard problem one level down. That is
   exactly how the transitive gaps got there.

## Testing contract

A verifier that cannot fail is decoration. Each check ships with proof in **both** directions:

- break the thing → the check must go red;
- remove the tool or the network → the check must go yellow, never red.

`scripts/verify-selftest.sh` runs those cases.
