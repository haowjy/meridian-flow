# Probe repairs

- `append-novelty.mts`, arms `f-reserved-target-committed-between` and
  `g-restoration-under-concurrent-row`: reconcile the pre-review-root fixtures
  with current admission/restoration behavior. On the G2 branch, f authors a
  now-protected root and throws before its intended race; g admits the restore
  but observes zero certified aliases. Keep the named risks and build the
  current writer/server evidence paths rather than weakening the assertions.
  Also ensure a failed arm unwinds its pause and gateway so the runner can
  finish and drop its scratch database. Found by work `diff-based-review`, G2.
