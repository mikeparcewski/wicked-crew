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

# ── The contract (scripts/VERIFY-DESIGN.md) ──────────────────────────────────
# I1 verdicts come from evidence · I2 the local environment is never a verdict · I3 registry input
# is hostile · I4 bounded · I5 read-only · I6 absence of evidence is not evidence of absence.
#
# I2 is the one this file kept violating. Nine review rounds each flagged ONE unguarded command;
# an audit then showed 2 of 10 were guarded and 5 of 6 checks could report a missing local tool as
# an ecosystem regression. Per-call-site guards are why: eight were simply never visited. So the
# probe happens ONCE, here, and `need` is the single gate every check passes through — a new check
# that forgets it is visible at a glance rather than after a reviewer trips over it.
MISSING_REASON=""

# `command -v` is a shell BUILTIN, so probing on demand costs nothing and needs no cache. The first
# cut memoized into an associative array — which is bash 4+, and macOS ships bash 3.2, so the whole
# script died on `declare -A` on the most common developer machine. Portability is part of the
# contract here: a verifier that will not start is the same as one that reports nothing.
need() {
  local miss="" c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || miss="$miss $c"; done
  if [ -n "$miss" ]; then
    MISSING_REASON="requires${miss} (not installed — not a verdict)"
    return 1
  fi
  return 0
}

# run_bounded <seconds> <cmd>... — I4. Uses timeout/gtimeout when present; otherwise a shell
# watchdog, because running unbounded trades a false verdict for NO verdict, and a verifier that
# never returns is the only failure nothing reports. Echoes stdout; returns the command's status,
# or 124 on deadline, exactly as timeout does.
run_bounded() {
  local secs="$1"; shift
  if command -v timeout  >/dev/null 2>&1; then timeout  "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
  local out rc pid waited=0
  out=$(mktemp "${TMPDIR:-/tmp}/wv-bounded.XXXXXX") || return 125
  ( "$@" >"$out" 2>/dev/null ) & pid=$!
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$secs" ]; do sleep 1; waited=$((waited+1)); done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; rc=124
  else wait "$pid" 2>/dev/null; rc=$?; fi
  cat "$out" 2>/dev/null; rm -f "$out"
  return "$rc"
}

# The workspace holding the sibling wicked-* checkouts. Defaults to this repo's parent, which is
# the layout every checkout already has; override for anything else. Checks that need a sibling
# repo SKIP rather than fail when it is absent — a missing checkout is not a broken ecosystem.
ROOT="${WICKED_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# ── Safe extraction of REMOTE tarballs ───────────────────────────────────────
# These come off the public npm registry, which is the supply-chain shape: a compromised or merely
# malformed tarball can carry absolute paths, `..` segments, or symlinks that escape the extraction
# root and write wherever the running user can. A temp dir is not a sandbox. So every member is
# inspected BEFORE anything is unpacked, and one bad entry rejects the whole archive rather than
# extracting the "safe" part of a hostile file.
#
# Returns non-zero on refusal so callers SKIP — a tarball we would not extract is not evidence of
# an ecosystem regression.
safe_untar() { # safe_untar <tarball> <dest-dir>
  need tar awk || return 1
  local tb="$1" dest="$2" listing
  listing=$(tar tzf "$tb" 2>/dev/null) || return 1
  [ -z "$listing" ] && return 1
  # Absolute paths and parent-traversal, decided per SEGMENT rather than by pattern-matching the
  # whole string. Regexes here are whack-a-mole — the first version handled `../x`, `/../`, and a
  # trailing `/..`, and a bare `..` member slipped past the guard entirely (it was refused, but by
  # accident, as an unreadable listing). Splitting on `/` and rejecting any segment that IS `..`,
  # plus any leading `/`, is exhaustive by construction and needs no case analysis.
  if printf '%s\n' "$listing" | awk -F/ '
      /^\// { exit 1 }
      { for (i = 1; i <= NF; i++) if ($i == "..") exit 1 }
    '; then :; else
    return 2
  fi
  # ALLOWLIST the member types instead of blacklisting the dangerous ones. Links were the obvious
  # escape (a symlink pointing outside, then a later member written THROUGH it) and rejecting only
  # `l`/`h` left FIFOs, character and block devices accepted from an untrusted registry tarball —
  # abusable on their own, and considerably worse if this ever runs as root. A published npm
  # package needs regular files and directories and nothing else, so anything whose `tar -tvzf`
  # type column is not `-` or `d` refuses the archive. Verified against tarballs carrying p/c/b
  # members built with exact headers.
  #
  # If the VERBOSE listing fails while the plain one succeeded, refuse too — proceeding would skip
  # the type check silently, extracting an unchecked archive under the appearance of a checked one.
  local verbose
  verbose=$(tar -tvzf "$tb" 2>/dev/null) || return 3
  printf '%s\n' "$verbose" | awk '{ t = substr($1, 1, 1); if (t != "-" && t != "d") exit 1 }' || return 3
  # NOTE the check/use boundary: members are inspected from one read and extracted in another.
  # Safe here only because $tb is a temp file this script just wrote and nothing else touches.
  # Do not point safe_untar at a path another process can swap between the two reads.
  mkdir -p "$dest" && tar xzf "$tb" -C "$dest" 2>/dev/null
}

# ── 1. Manifest version == what npm actually serves ──────────────────────────
# A release can publish while `main` keeps the old number: the release-sync PR is a separate PR
# and can sit unmerged for days. Both crew and garden were in exactly that state.
head_ "1 · published version matches main"
check_version() {
  local repo="$1" pj="$2"
  local dir="$ROOT/$repo"
  need git node npm || { skip "$repo — $MISSING_REASON"; return; }
  [ -d "$dir/.git" ] || { skip "$repo — not checked out"; return; }
  # A FAILED FETCH MEANS THE REF MAY BE STALE. Comparing a days-old local `origin/main` against
  # live npm can manufacture either verdict — a false DRIFT for a version already synced, or a
  # false PASS for one that is not. Same rule as everywhere else here: infrastructure skips.
  if ! git -C "$dir" fetch -q origin 2>/dev/null; then
    skip "$repo — could not fetch origin (offline? local ref may be stale, not a verdict)"; return
  fi
  local name main npmv
  # The path goes in as an ARGUMENT, not interpolated into a JS string literal: a checkout under
  # a directory containing a space or an apostrophe ("we ird's") makes the interpolated form throw
  # a syntax error, which this would then report as an unreadable manifest (verified).
  name=$(node -e 'const p=require(process.argv[1]);process.stdout.write(String(p.name||""))' "$dir/$pj" 2>/dev/null) \
    || { skip "$repo — unreadable manifest"; return; }
  [ -z "$name" ] && { skip "$repo — manifest has no name"; return; }
  # An unreadable `origin/main:$pj` means offline, no origin, or a moved path — NOT a version
  # mismatch. Reporting "main=? npm=1.2.3" as a failure is the same infrastructure-as-verdict
  # mistake the bundle and installer checks make below, and it must skip for the same reason.
  main=$(git -C "$dir" show "origin/main:$pj" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).version;if(typeof v==="string"&&v)console.log(v)}catch{}})')
  if [ -z "$main" ]; then skip "$name — cannot read origin/main:$pj (offline? not a verdict)"; return; fi
  npmv=$(npm view "$name" version 2>/dev/null)
  if [ -z "$npmv" ]; then skip "$name — not on npm (or npm unreachable)"
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
  need npm curl tar diff mktemp || { skip "crew/studio bundle — $MISSING_REASON"; return; }
  local tmp; tmp=$(mktemp -d "${TMPDIR:-/tmp}/wicked-verify.XXXXXX")
  local crewv range studiov
  crewv=$(npm view wicked-crew version 2>/dev/null)
  range=$(npm view wicked-crew@"$crewv" devDependencies.wicked-studio 2>/dev/null)
  # RESOLVE the range; do not strip characters off it. `^0.4.0` does not mean 0.4.0 — npm installs
  # the highest 0.4.x, so `tr -d '^~'` would compare crew's bundle against the wrong tarball and
  # report DIFFERS for a correctly-bundled crew. Getting caret semantics wrong inside the check
  # that exists BECAUSE of caret semantics is precisely the failure to avoid here.
  if [ -n "$range" ]; then
    # --json, because the plain form is ambiguous: one match prints a bare version, several print
    # `pkg@x.y.z 'x.y.z'` lines. Naive `tail -1 | tr -d` on the multi-match form yields
    # "wicked-garden@12.31.012.31.0" — garbage that would then fail to resolve. The JSON is a
    # string for one match and an array for many; take the LAST, which is the highest npm would
    # install for the range.
    studiov=$(npm view "wicked-studio@${range}" version --json 2>/dev/null | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const v=JSON.parse(s);const out=Array.isArray(v)?v[v.length-1]:v;
            if(typeof out==="string"&&out)console.log(out);}catch{}
      })')
  fi
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
  if ! ( cd "$tmp" && curl -fsSL "$crew_tb" -o c.tgz && curl -fsSL "$studio_tb" -o s.tgz ) >/dev/null 2>&1; then
    skip "crew/studio bundle — tarball fetch failed (not a verdict)"; rm -rf "$tmp"; return
  fi
  if ! safe_untar "$tmp/c.tgz" "$tmp/c" || ! safe_untar "$tmp/s.tgz" "$tmp/s"; then
    skip "crew/studio bundle — tarball refused or unextractable (unsafe members?)"; rm -rf "$tmp"; return
  fi
  # `diff` missing exits 127, and mapping any non-zero to "DIFFERS" turns a tooling gap into an
  # ecosystem regression — the same infrastructure-as-verdict bug already fixed in the npm, tarball
  # and site checks. Third time in this file: the rule is "only evidence produces a verdict", and
  # it has to be applied to every external command, not just the ones that felt like network.
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
  need npm curl tar node grep mktemp || { skip "installer status — $MISSING_REASON"; return; }
  local tmp; tmp=$(mktemp -d "${TMPDIR:-/tmp}/wicked-verify.XXXXXX")
  local tb; tb=$(npm view wicked-installer dist.tarball 2>/dev/null)
  if [ -z "$tb" ] || ! ( cd "$tmp" && curl -fsSL "$tb" -o i.tgz ) >/dev/null 2>&1 \
     || ! safe_untar "$tmp/i.tgz" "$tmp" \
     || ! ( cd "$tmp/package" && npm install --omit=dev --ignore-scripts --silent ) >/dev/null 2>&1; then
    skip "installer status — could not fetch/verify/install the published tarball (not a verdict)"
    rm -rf "$tmp"; return
  fi
  # I4: one bounded-run helper, so no call site can accidentally run unbounded.
  local out rc
  out=$(cd "$tmp/package" && run_bounded 120 node dist/index.js status 2>/dev/null); rc=$?
  # A crash, a timeout, or empty output is a FAILURE of the published artifact — not a machine
  # with nothing installed. Conflating the two is how a broken `status` would pass this check.
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
    bad "installer status exited $rc with $( [ -z "$out" ] && echo "no output" || echo "output" ) — the published artifact does not run"
    rm -rf "$tmp"; return
  fi
  # The regression this replaced: everything the switch did not name reported "not installed".
  # One-or-more spaces: the padding is `status`'s presentation detail, and pinning the exact
  # column count would make this guard miss the regression after any cosmetic change to it.
  if grep -qE "not installed +wicked-crew" <<<"$out" && command -v wicked-crew >/dev/null 2>&1; then
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
  need curl || { skip "$3 — $MISSING_REASON"; return; }
  local url="$1" needle="$2" label="$3" body rc
  # -f so a 4xx/5xx fails instead of handing back an error page, which would otherwise count as
  # "reachable" and — with a generic enough needle — could even match it.
  # A DOWN NETWORK IS NOT A BROKEN SITE, and the honest way to tell them apart is whether the
  # SERVER ANSWERED — not which exit code curl chose. Mapping exit codes was the first attempt and
  # it was guesswork: a 404 from Pages came back as 56 (connection reset mid-transfer), which had
  # been classified as "network", so a genuinely broken page would have been quietly skipped.
  # `%{http_code}` is unambiguous: non-zero ⇒ the server responded and the verdict is about the
  # site; 000 ⇒ nothing answered and the verdict is about this machine.
  # NOTE: no `|| echo 000` fallback. curl ALREADY writes `000` when nothing answered, so appending
  # on failure yields "000000" — which matches neither branch and falls through to the wrong one.
  # (The identical `cmd || echo <default>` mistake produced "0\n0" from `grep -c` earlier in this
  # session: the command emits its own default AND the fallback fires.) Capture, then default only
  # when the capture is genuinely empty.
  local code
  code=$(curl -sSL -o /dev/null -w '%{http_code}' -m 20 "$url" 2>/dev/null)
  [ -z "$code" ] && code=000
  if [ "$code" = "000" ]; then
    skip "$label — no HTTP response at all (offline/DNS? not a verdict)"; return
  fi
  if [ "$code" -ge 400 ] 2>/dev/null; then
    bad "$label — $url returned HTTP $code"; return
  fi
  body=$(curl -fsSL -m 20 "$url" 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ]; then bad "$label — $url answered $code but the body could not be read (curl $rc)"
  elif [ -z "$body" ]; then bad "$label — $url answered $code with an empty body"
  # A QUOTED variable inside a `[[ ]]` pattern is ALREADY a literal — bash suppresses globbing for
  # the quoted portion, so `w?rld` does not match `world` here (verified). A review round called
  # this a glob and I swapped it for `grep -qF`, which broke the wi.wickedagile.com check outright
  # while the needle was demonstrably present in the body. Reverted: the original was correct, and
  # the replacement was both unnecessary and wrong.
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
  # Distinguish "the file is gone" (could be a checkout state) from "the file exists and no longer
  # carries the reference" (a real regression). grep on a missing file returns the same 1 as grep
  # that found nothing, so the file check has to come first or the two are indistinguishable.
  wired() { # wired <file> <needle> <ok-msg> <bad-msg>
    if ! need grep; then skip "$(basename "$1") — $MISSING_REASON"
    elif [ ! -f "$1" ]; then skip "$(basename "$1") not present in this checkout (not a verdict)"
    # -F: the needles are literal PATHS, and in regex mode `create.js` also matches `createXjs`
    # and `create-js` (verified). A check whose entire purpose is "this exact reference is still
    # here" must not accept a near-miss — that is a false PASS, the silent kind.
    elif grep -qF -- "$2" "$1" 2>/dev/null; then ok "$3"
    else bad "$4"; fi
  }
  wired "$WI/bin/wicked-interactive.js" 'src/artifact/create.js' \
    "src/artifact/ still backs the create|publish|validate|adopt subcommands" \
    "bin no longer imports src/artifact — were the CLI subcommands removed?"
  wired "$WI/src/service/server.js" 'frontend/dist' \
    "frontend/dist is still the served static root" \
    "server.js no longer serves frontend/dist"
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
