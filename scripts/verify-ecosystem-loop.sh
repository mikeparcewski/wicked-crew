#!/usr/bin/env bash
# Re-run verify-ecosystem.sh until it passes (or N attempts), for use while releases propagate.
#
# npm's registry, GitHub Pages' CDN, and a Pages deploy all settle on their own schedules — a
# failure minutes after a publish usually means "not yet", not "broken". This distinguishes the
# two by retrying: a check that stays red across attempts is a real regression.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${1:-900}"; MAX="${2:-8}"
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
