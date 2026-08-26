#!/usr/bin/env bash
# verify-selftest.sh — does the verifier actually fail when it should?
#
# A verifier that cannot fail is decoration, and one that reports a missing local tool as an
# ecosystem regression is worse than none: it trains people to ignore it. So each case here drives
# verify-ecosystem.sh into a known state and asserts the DIRECTION of the verdict:
#
#   break the ecosystem      -> must go RED    (a missed regression is silent, the worst outcome)
#   remove a tool / network  -> must go YELLOW (never red; the machine is not the ecosystem)
#
# Read-only with respect to the ecosystem: every mutation is to a temp copy or is restored in a
# trap, so an interrupted run cannot leave a repo edited.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="$HERE/verify-ecosystem.sh"
ROOT="${WICKED_ROOT:-$(cd "$HERE/../.." && pwd)}"
PASS=0; FAIL=0
ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }

# The self-test is held to the SAME contract it enforces (I2): a tool it needs but lacks must not
# be reported as a verdict about the verifier. Without python3 the mutation silently does not
# happen, the verifier correctly stays green, and this would have called that a FAILURE of the
# guard — a wrong verdict produced by the thing whose entire job is catching wrong verdicts.
for _t in python3 mktemp cp awk sed; do
  command -v "$_t" >/dev/null 2>&1 || {
    printf "  \033[33m~\033[0m self-test cannot run: requires %s\n" "$_t" >&2
    exit 0
  }
done

RESTORE=()
cleanup() { local r; for r in "${RESTORE[@]:-}"; do [ -n "$r" ] && eval "$r"; done; }
trap cleanup EXIT INT TERM

counts() { # counts <output> -> "pass fail skip"
  printf '%s' "$1" | sed 's/\x1b\[[0-9;]*m//g' \
    | awk '/passed · .* failed · .* skipped/ { print $1, $4, $7 }' | tail -1
}

printf "\n\033[1mA · breaking the ecosystem must go RED\033[0m\n"

# Each pair: a file, and a literal the verifier asserts is present in it.
break_case() { # break_case <label> <file> <from> <to>
  local label="$1" file="$2" from="$3" to="$4"
  if [ ! -f "$file" ]; then
    printf "  \033[33m~\033[0m %s — %s absent, cannot test here\n" "$label" "$file"; return
  fi
  local backup; backup=$(mktemp "${TMPDIR:-/tmp}/selftest.XXXXXX")
  cp "$file" "$backup"
  # printf %q, not hand-rolled single quotes: a checkout under a directory containing an
  # apostrophe ("we ird's") makes the quoted form syntactically wrong, the eval fails, and the
  # repo is left MUTATED — breaking the one guarantee this suite makes about itself.
  RESTORE+=("$(printf 'cp %q %q; rm -f %q' "$backup" "$file" "$backup")")
  python3 - "$file" "$from" "$to" <<'PY'
import sys
p,a,b=sys.argv[1],sys.argv[2],sys.argv[3]
s=open(p,encoding='utf-8').read()
# ALL occurrences: `wired` is a DELETION canary — it asks whether the reference still exists at
# all. Replacing only the first left a second mount in place and the check correctly stayed green,
# which made the test look like it had found a hole in the check when the hole was in the test.
open(p,'w',encoding='utf-8').write(s.replace(a,b))
PY
  # Confirm the mutation LANDED before judging the verdict. If the edit silently no-ops, the
  # verifier stays green for the right reason and this would blame the guard for it.
  if ! grep -qF -- "$to" "$file" 2>/dev/null; then
    cp "$backup" "$file"; rm -f "$backup"; RESTORE=("${RESTORE[@]:0:${#RESTORE[@]}-1}")
    printf "  \033[33m~\033[0m %s — mutation did not apply, nothing proven\n" "$label"; return
  fi
  local out; out=$("$VERIFY" 2>&1)
  local c; c=$(counts "$out"); local f; f=$(echo "$c" | awk '{print $2}')
  # Restore inline AND drop the trap entry — leaving it queued made the exit trap re-run a `cp`
  # from a backup this line had already deleted, printing errors that looked like a failure.
  cp "$backup" "$file"; rm -f "$backup"; RESTORE=("${RESTORE[@]:0:${#RESTORE[@]}-1}")
  if [ "${f:-0}" -ge 1 ]; then ok "$label — went red ($c)"; else bad "$label — stayed green, the guard is decoration ($c)"; fi
}

break_case "src/artifact reference removed" \
  "$ROOT/wicked-interactive/bin/wicked-interactive.js" "src/artifact/create.js" "src/artifact/GONE.js"
break_case "near-miss must not pass (create.js vs createXjs)" \
  "$ROOT/wicked-interactive/bin/wicked-interactive.js" "src/artifact/create.js" "src/artifact/createXjs"
break_case "static root no longer served" \
  "$ROOT/wicked-interactive/src/service/server.js" "frontend/dist" "frontend/GONE"

printf "\n\033[1mB · a missing tool must go YELLOW, never red\033[0m\n"
# A PATH with only the shell essentials: npm/curl/tar/git/node/diff are all absent.
STUB=$(mktemp -d "${TMPDIR:-/tmp}/selftest-bin.XXXXXX")
for c in bash sh awk grep sed printf cat mktemp rm mkdir dirname basename kill sleep wait; do
  p=$(command -v "$c" 2>/dev/null) && ln -sf "$p" "$STUB/$c" 2>/dev/null
done
out=$(PATH="$STUB" "$VERIFY" 2>&1); c=$(counts "$out")
f=$(echo "$c" | awk '{print $2}'); sk=$(echo "$c" | awk '{print $3}')
rm -rf "$STUB"
if [ "${f:-1}" = "0" ] && [ "${sk:-0}" -ge 1 ]; then
  ok "no tooling ⇒ 0 failed, $sk skipped ($c)"
else
  bad "no tooling produced FAILURES — the machine was reported as the ecosystem ($c)"
fi

printf "\n\033[1mC · a healthy run is green\033[0m\n"
out=$("$VERIFY" 2>&1); c=$(counts "$out"); f=$(echo "$c" | awk '{print $2}')
if [ "${f:-1}" = "0" ]; then ok "clean run ($c)"; else bad "clean run reported failures ($c)"; fi

printf "\n\033[1m%d passed · %d failed\033[0m\n" "$PASS" "$FAIL"
exit "$FAIL"
