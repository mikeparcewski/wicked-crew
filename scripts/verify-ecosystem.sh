#!/usr/bin/env bash
# verify-ecosystem.sh — re-derive "done" for the whole wicked-* ecosystem from evidence.
#
# Every check answers a question about the WORLD, not about this repo's intentions: what npm
# actually serves, what the published tarball actually contains, what the live site actually
# returns, what the installed binaries actually report. Nothing here trusts a green CI badge, a
# version string in a manifest, or a claim in a doc — each of those has been wrong at least once
# in this ecosystem's history, and each wrong one is in here as a named check because of it.
#
# Exit 0 = every check passed. Non-zero = the count of failures.
#
# Usage:  scripts/verify-ecosystem.sh                 # one pass, exit code = failure count
#         scripts/verify-ecosystem-loop.sh 900 8    # retry every 15 min, up to 8 passes
#
# This script takes no flags. Looping lives in the sibling script so the single-pass exit code
# stays meaningful to CI.
set -uo pipefail

PASS=0; FAIL=0; SKIP=0
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
skip() { printf "  \033[33m~\033[0m %s\n" "$1"; SKIP=$((SKIP+1)); }
head_() { printf "\n\033[1m%s\033[0m\n" "$1"; }

# The workspace holding the sibling wicked-* checkouts. Defaults to this repo's parent, which is
# the layout every checkout already has; override for anything else. Checks that need a sibling
# repo SKIP rather than fail when it is absent — a missing checkout is not a broken ecosystem.
ROOT="${WICKED_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# ── 1. Manifest version == what npm actually serves ──────────────────────────
# A release can publish while `main` keeps the old number: the release-sync PR is a separate PR
# and can sit unmerged for days. Both crew and garden were in exactly that state.
head_ "1 · published version matches main"
check_version() {
  local repo="$1" pj="$2"
  local dir="$ROOT/$repo"
  [ -d "$dir/.git" ] || { skip "$repo — not checked out"; return; }
  git -C "$dir" fetch -q origin 2>/dev/null
  local name main npmv
  name=$(node -p "require('$dir/$pj').name" 2>/dev/null) || { skip "$repo — unreadable manifest"; return; }
  main=$(git -C "$dir" show "origin/main:$pj" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("?")}})')
  npmv=$(npm view "$name" version 2>/dev/null)
  if [ -z "$npmv" ]; then skip "$name — not on npm"
  elif [ "$main" = "$npmv" ]; then ok "$name $npmv"
  else bad "$name — main=$main npm=$npmv (release-sync PR unmerged?)"; fi
}
check_version wicked-crew        packages/crew/package.json
check_version wicked-crew        packages/crew-api-types/package.json
check_version wicked-studio      package.json
check_version wicked-interactive package.json
check_version wicked-garden      package.json
check_version wicked-bus         package.json
check_version wicked-installer   package.json
check_version wicked-core        crates/wicked-core-ts/package.json

# ── 2. crew's bundled skin is the studio it claims ───────────────────────────
# `build:with-studio` copies whatever is INSTALLED. A caret on a 0.x pin locks the MINOR, so
# `^0.2.0` could never resolve 0.3.0 and crew shipped a stale UI while every check stayed green.
# String-matching the bundle does NOT catch this: the marker strings existed in both versions.
head_ "2 · crew bundles the studio version it depends on"
verify_bundle() {
  local tmp; tmp=$(mktemp -d)
  local crewv studiov
  crewv=$(npm view wicked-crew version 2>/dev/null)
  studiov=$(npm view wicked-crew@"$crewv" devDependencies.wicked-studio 2>/dev/null | tr -d '^~')
  [ -z "$studiov" ] && studiov=$(npm view wicked-studio version 2>/dev/null)
  # INFRASTRUCTURE FAILURE IS NOT A VERDICT. If npm is unreachable or a tarball will not extract,
  # this must SKIP — reporting "bundle DIFFERS" because curl timed out is a false regression, and
  # a verifier that cries wolf on a network hiccup is one people learn to ignore.
  local crew_tb studio_tb
  crew_tb=$(npm view wicked-crew@"$crewv" dist.tarball 2>/dev/null)
  studio_tb=$(npm view wicked-studio@"$studiov" dist.tarball 2>/dev/null)
  if [ -z "$crewv" ] || [ -z "$studiov" ] || [ -z "$crew_tb" ] || [ -z "$studio_tb" ]; then
    skip "crew/studio bundle — npm unreachable (not a verdict)"; rm -rf "$tmp"; return
  fi
  if ! ( cd "$tmp" \
    && curl -fsSL "$crew_tb"   -o c.tgz \
    && curl -fsSL "$studio_tb" -o s.tgz \
    && mkdir -p c s && tar xzf c.tgz -C c && tar xzf s.tgz -C s ) >/dev/null 2>&1; then
    skip "crew/studio bundle — tarball fetch/extract failed (not a verdict)"; rm -rf "$tmp"; return
  fi
  if [ ! -d "$tmp/c/package/dist/studio" ]; then
    bad "crew $crewv ships no dist/studio"
  elif diff -r "$tmp/s/package/dist" "$tmp/c/package/dist/studio" >/dev/null 2>&1; then
    ok "crew $crewv bundles studio $studiov byte-identically"
  else
    bad "crew $crewv bundle DIFFERS from studio $studiov — stale pin?"
  fi
  rm -rf "$tmp"
}
verify_bundle

# ── 3. The published artifacts actually run ──────────────────────────────────
# A green publish job proves a publish happened, not that the thing works. installer 0.4.0's whole
# reason for existing was a `status` command that lied about what was installed.
head_ "3 · published artifacts behave"
verify_installer() {
  local tmp; tmp=$(mktemp -d)
  local tb; tb=$(npm view wicked-installer dist.tarball 2>/dev/null)
  if [ -z "$tb" ] || ! ( cd "$tmp" && curl -fsSL "$tb" -o i.tgz && tar xzf i.tgz \
    && cd package && npm install --omit=dev --silent ) >/dev/null 2>&1; then
    skip "installer status — could not fetch/install the published tarball (not a verdict)"
    rm -rf "$tmp"; return
  fi
  local out rc
  out=$(cd "$tmp/package" && timeout 120 node dist/index.js status 2>/dev/null); rc=$?
  # A crash, a timeout, or empty output is a FAILURE of the published artifact — not a machine
  # with nothing installed. Conflating the two is how a broken `status` would pass this check.
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
    bad "installer status exited $rc with $( [ -z "$out" ] && echo "no output" || echo "output" ) — the published artifact does not run"
    rm -rf "$tmp"; return
  fi
  # The regression this replaced: everything the switch did not name reported "not installed".
  if grep -q "not installed  wicked-crew" <<<"$out" && command -v wicked-crew >/dev/null 2>&1; then
    bad "installer status says wicked-crew missing while it is on PATH (detection regressed)"
  elif grep -qE "installed +wicked-(crew|estate)" <<<"$out"; then
    ok "installer status detects binaries that are actually present"
  else
    skip "installer status — no wicked-* products installed here to detect"
  fi
  rm -rf "$tmp"
}
verify_installer

# ── 4. Live product sites serve their claims ─────────────────────────────────
# A deploy can succeed and serve the previous build; Pages fronts a CDN. Assert CONTENT.
head_ "4 · live sites serve the features they document"
site_has() {
  local url="$1" needle="$2" label="$3"
  # -f makes curl fail on 4xx/5xx instead of handing back an error page, which could otherwise
  # be "reachable" and — with a generic enough needle — even match.
  local body; body=$(curl -fsSL -m 20 "$url" 2>/dev/null)
  if [ -z "$body" ]; then bad "$label — $url unreachable or returned an HTTP error"
  elif [[ "$body" == *"$needle"* ]]; then ok "$label"
  else bad "$label — $url served but missing: $needle"; fi
}
site_has https://ws.wickedagile.com "Co-located is not linked" "studio site documents the multi-repo graph AND its limit"
site_has https://wi.wickedagile.com "wicked-interactive"       "interactive site is live (it is the product site, not cruft)"

# ── 5. Things that must NOT be deleted ───────────────────────────────────────
# A 2026-08-24 audit called all three of these dead. Each is reachable only through an indirection
# a text search does not follow: a dynamic import(), an existsSync-guarded static mount, and a CI
# working-directory. See wicked-interactive#186.
head_ "5 · load-bearing code an audit called cruft"
WI="$ROOT/wicked-interactive"
if [ -d "$WI" ]; then
  grep -q 'src/artifact/create.js' "$WI/bin/wicked-interactive.js" 2>/dev/null \
    && ok "src/artifact/ still backs the create|publish|validate|adopt subcommands" \
    || bad "bin no longer imports src/artifact — were the CLI subcommands removed?"
  grep -q 'frontend/dist' "$WI/src/service/server.js" 2>/dev/null \
    && ok "frontend/dist is still the served static root" \
    || bad "server.js no longer serves frontend/dist"
  [ -f "$WI/.github/workflows/pages.yml" ] \
    && ok "site/ still has its Pages deploy" \
    || bad "interactive pages.yml is gone — the live site would stop updating"
else
  skip "wicked-interactive not checked out"
fi

# ── 6. The frozen archive is intact ──────────────────────────────────────────
head_ "6 · frozen archive untouched"
# Only meaningful where the archive EXISTS to be protected. A fresh machine or a CI runner never
# had one, and failing there would make this script unrunnable in the place it is most useful.
# WICKED_EXPECT_BRAIN_ARCHIVE=1 turns absence into a failure for machines that should have it.
if [ -d "$HOME/.wicked-brain" ]; then
  ok "~/.wicked-brain present (retired, must never be deleted)"
elif [ "${WICKED_EXPECT_BRAIN_ARCHIVE:-0}" = "1" ]; then
  bad "~/.wicked-brain is GONE and was expected — that archive is not recreatable"
else
  skip "~/.wicked-brain absent (set WICKED_EXPECT_BRAIN_ARCHIVE=1 where it should exist)"
fi

# ── Result ───────────────────────────────────────────────────────────────────
printf "\n\033[1m%d passed · %d failed · %d skipped\033[0m\n" "$PASS" "$FAIL" "$SKIP"
exit "$FAIL"
