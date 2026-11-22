Real `wicked-estate 0.35.10` output (crew#1713, crew#1714), captured from a scratch store, not hand-written:
three repos indexed under labels `api`, `web` and `gone`, `link --project p1 --labels api,web`
(one proven package link web -> api), then uncommitted edits in `api` and `gone` (stale files) and a
re-index of `web` (the link goes stale, `stale_labels: ["web"]`).

- `blast-radius-removed-member.json`: `blast-radius charge --json`. `gone` plays the removed member: its
  rows, `via` edges and stale file are in the answer, as they are until the next project refresh.
- `path-linked-stale.json`: `path web/src/page.ts api/src/index.ts --json` (found, one crossing, stale link).
- `path-unlinked-stale.json`: `path page charge --json` (not found, no crossing, stale link).

The only edit: `freshness.roots[].root` (host paths) became `~/fx/<label>`.
