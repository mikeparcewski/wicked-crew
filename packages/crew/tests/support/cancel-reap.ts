// crew#1509 — what a cancelled run's trail and disk say once its reap is done.
//
// Since wicked-core-ts 0.15.39 (core#1433, wicked-core#1429) a cancel waits at most 500 ms for its worktree reap and
// then emits `runCancelled` while the reap goes on. A reap slower than that leaves two windows a suite must not judge
// in: a dirty tree's `worktreeRetained` can arrive AFTER `runCancelled`, and a clean tree can still be on disk, being
// deleted, with no frame. So a suite checks that the cancel is booked (nothing but a retention frame after it), and
// compares wire and disk only once the reap has settled: the tree is gone, or the wire says it was retained.

export type Frame = Record<string, unknown>;

/** The run's cancel is on the trail, and only a reap's `worktreeRetained` may follow it. */
export function cancelBooked(trail: readonly Frame[]): boolean {
  const at = trail.map((e) => e['type']).lastIndexOf('runCancelled');
  return at !== -1 && trail.slice(at + 1).every((e) => e['type'] === 'worktreeRetained');
}

/** The reap is done: the wire says the tree was retained, or the tree is no longer on disk. Until then, a tree on disk
 *  with no frame is a clean tree still being deleted, not a disagreement. */
export function reapSettled(trail: readonly Frame[], onDisk: boolean): boolean {
  return !onDisk || trail.some((e) => e['type'] === 'worktreeRetained');
}
