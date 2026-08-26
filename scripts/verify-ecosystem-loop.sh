#!/usr/bin/env bash
# Re-run verify-ecosystem.sh until it passes (or N attempts), for use while releases propagate.
#
# npm's registry, GitHub Pages' CDN, and a Pages deploy all settle on their own schedules — a
# failure minutes after a publish usually means "not yet", not "broken". This distinguishes the
# two by retrying: a check that stays red across attempts is a real regression.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${1:-900}"; MAX="${2:-8}"

# Validate before the arithmetic loop. bash evaluates a non-numeric name as 0, so `MAX=xyz` makes
# `for (( i=1; i<=MAX; i++ ))` run ZERO times — the script would verify nothing and exit quietly,
# which for a verifier is the worst possible failure: silence that reads as success.
for pair in "INTERVAL:$INTERVAL" "MAX:$MAX"; do
  name=${pair%%:*}; val=${pair#*:}
  case "$val" in
    ''|*[!0-9]*) echo "usage: $(basename "$0") [interval-seconds] [max-passes]   ($name must be a positive integer, got '$val')" >&2; exit 2 ;;
  esac
  [ "$val" -lt 1 ] && { echo "usage: $(basename "$0") [interval-seconds] [max-passes]   ($name must be >= 1, got '$val')" >&2; exit 2; }
done
# Arithmetic loop rather than `seq`, which is not guaranteed in a minimal container.
for (( i=1; i<=MAX; i++ )); do
  printf "\n\033[1m── pass %d/%d ──\033[0m\n" "$i" "$MAX"
  if "$HERE/verify-ecosystem.sh"; then
    printf "\n\033[32mecosystem verified on pass %d\033[0m\n" "$i"; exit 0
  fi
  [ "$i" -lt "$MAX" ] && { echo "retrying in ${INTERVAL}s — transient propagation vs real regression"; sleep "$INTERVAL"; }
done
printf "\n\033[31mstill failing after %d passes — treat as a real regression\033[0m\n" "$MAX"
exit 1
