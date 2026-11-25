/** Base-only re-delivery: the same resolver and GitHub identity as delivery, with an exact lease. */
import type { DeliveryAssurance, RedeliverRunResult } from 'wicked-crew-api-types';
import { CHANGELOG_REBASE_LINES, REBASING_LINE, GH_CALL_LINE, GITHUB_CREDENTIAL_LINES, SCRIPT_GIT_ENV_LINES, isSafeRefName, shellSingleQuote } from './deliver.js';
export interface RefreshOptions {
  repo: string;
  base: string;
  head: string;
  deliveredHead: string;
  worktree: string;
  branch: string;
  identity?: string | undefined;
}
function preamble(o: RefreshOptions): string[] {
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo) || !isSafeRefName(o.base) || !isSafeRefName(o.head) || !isSafeRefName(o.branch) || !/^[a-f0-9]{40}$/.test(o.deliveredHead))
    throw new Error('redeliver: invalid repository, ref or delivered head');
  return [
    'set -euo pipefail', 'exec 2>&1', ...SCRIPT_GIT_ENV_LINES,
    `GHREPO=${shellSingleQuote(o.repo)}`, `BASE=${shellSingleQuote(o.base)}`, `HEADREF=${shellSingleQuote(o.head)}`, `OLD=${shellSingleQuote(o.deliveredHead)}`,
    `WT=${shellSingleQuote(o.worktree)}`, `BRANCH=${shellSingleQuote(o.branch)}`,
    "GHT=''", "GHPIN=''", "GHGIT=''",
    ...(o.identity ? [`GH_ACCOUNT=${shellSingleQuote(o.identity)}`] : []),
    '_credmissing() { echo "redeliver: $2"; exit 1; }',
    GH_CALL_LINE, ...GITHUB_CREDENTIAL_LINES,
    'unset GH_TOKEN',
    'if [ -n "$GHT" ]; then GHGIT="https://github.com/$GHREPO.git"; fi',
    // Reuse delivery's refusal of URL rewrites before a pinned fetch or push.
    'if [ -n "$GHGIT" ]; then while IFS= read -r RW; do RWV=${RW#* }; [ -n "$RW" ] && [ -n "$RWV" ] || continue; case "$GHGIT" in "$RWV"*) echo "redeliver: git config rewrites the pinned GitHub URL; nothing was pushed"; exit 1;; esac; done <<GHRW_EOF',
    "$(git config --get-regexp '^url\\..*\\.(push)?insteadof$' 2>/dev/null || true)",
    'GHRW_EOF',
    'fi',
    'NETGIT="${GHGIT:-origin}"',
    // The GitHub arm of deliver's _gnet, including header resets and redirect/protocol limits.
    `_gnet() { if [ -n "$GHGIT" ]; then GIT_CONFIG_COUNT=4 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1="http.$GHGIT.extraHeader" GIT_CONFIG_VALUE_1= GIT_CONFIG_KEY_2=http.followRedirects GIT_CONFIG_VALUE_2=false GIT_CONFIG_KEY_3="http.$GHGIT.followRedirects" GIT_CONFIG_VALUE_3=false GIT_ALLOW_PROTOCOL=https GH_TOKEN="$GHT" GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c 'credential.https://github.com.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f' "$@"; else git "$@"; fi; }`,
  ];
}
export function refreshRebaseScript(o: RefreshOptions): string {
  return [...preamble(o),
    '_gnet fetch -q "$NETGIT" "+refs/heads/$BASE:refs/remotes/origin/$BASE" "+refs/heads/$HEADREF:refs/remotes/origin/$HEADREF"',
    '[ "$(git rev-parse "origin/$HEADREF")" = "$OLD" ] || { echo "redeliver: MOVED"; exit 1; }',
    'git worktree add -q -b "$BRANCH" "$WT" "origin/$HEADREF"', 'cd "$WT"',
    REBASING_LINE,
    'if ! git rebase "origin/$BASE"; then',
    '  _rebasing || { echo "redeliver: rebase failed before it started"; exit 1; }',
    '  CF=$(git diff --name-only --diff-filter=U)',
    '  if [ -n "$CF" ] && ! printf "%s\\n" "$CF" | grep -qvE "(^|/)CHANGELOG\\.md$"; then echo "redeliver: RESOLVED"; printf "%s\\n" "$CF"; echo "redeliver: END"; fi',
    ...CHANGELOG_REBASE_LINES,
    '  if _rebasing; then CF=$(git diff --name-only --diff-filter=U); git rebase --abort; echo "redeliver: CONFLICT"; printf "%s\\n" "$CF"; echo "redeliver: END"; exit 1; fi',
    'fi',
    'echo "redeliver: REBASED old=$OLD new=$(git rev-parse HEAD) base=$(git rev-parse "origin/$BASE")"',
  ].join('\n');
}
/** ONE result drives the response and both PR disclosures. Assurance is carried forward unchanged. */
export function redeliveryText(result: RedeliverRunResult, assurance?: DeliveryAssurance): string {
  const c = result.checks;
  return `Re-delivered after a base-only rebase: ${result.oldHead} -> ${result.newHead}; repo checks re-run on the new tree: PASS (${c.count} checks) — ${c.names.join(', ')}${assurance === undefined ? '' : `; assurance: ${JSON.stringify(assurance)}`}`;
}
export function refreshPushScript(o: RefreshOptions, result: RedeliverRunResult, assurance?: DeliveryAssurance): string {
  return [...preamble(o),
    `TEXT=${shellSingleQuote(redeliveryText(result, assurance))}`, `URL=${shellSingleQuote(result.prUrl)}`,
    // Guard the exact checked commit too: a check implementation must never move the tree to push.
    `[ "$(git rev-parse HEAD)" = ${shellSingleQuote(result.newHead)} ] || { echo "redeliver: checked head changed"; exit 1; }`,
    'PUSH=$(mktemp "${TMPDIR:-/tmp}/wicked-redeliver-push.XXXXXX")',
    'BODY=$(mktemp "${TMPDIR:-/tmp}/wicked-redeliver-body.XXXXXX")',
    'trap \'rm -f "$PUSH" "$BODY"\' EXIT',
    'if ! _gnet push "--force-with-lease=refs/heads/$HEADREF:$OLD" "$NETGIT" "HEAD:refs/heads/$HEADREF" >"$PUSH" 2>&1; then cat "$PUSH"; if grep -qi "stale info" "$PUSH"; then echo "redeliver: MOVED"; fi; exit 1; fi',
    'cat "$PUSH"',
    '_gh pr comment "$URL" --body "$TEXT" || echo "redeliver: PR comment failed (push succeeded)"',
    // gh's jq selector writes the body as text; no second JSON parser or shell interpolation.
    'if _gh pr view "$URL" --json body --jq .body >"$BODY"; then',
    '  printf "\\n%s\\n" "$TEXT" >>"$BODY"',
    '  _gh pr edit "$URL" --body-file "$BODY" || echo "redeliver: PR body edit failed (push succeeded)"',
    'else echo "redeliver: PR body read failed (push succeeded)"; fi',
  ].join('\n');
}
