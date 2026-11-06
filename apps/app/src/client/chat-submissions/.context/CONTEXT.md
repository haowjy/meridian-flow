# client/chat-submissions — contracts

- Enumeration keeps account IDs segment-safe. Lock requests are bounded so a
  departed tab can't block takeover.
- A reused submission ID with a different payload is an idempotency conflict.
- A local write failure exposes Retry and doesn't authorize Edit or a re-mint.
- Edit stores a tab-local receipt so a reload can't prepend twice.
- A journal record carries its failure occurrence (`requestId`, `attempt`),
  separate from the idempotent submission ID. The driver saves a new occurrence
  before replay or Retry, so a failed local save can't collide with a later
  attempt after reload. Restored failures read the saved occurrence and don't
  allocate one while projecting.
- Storage events that change only occurrence metadata rebuild the view and don't
  wake another replay; another tab starting an attempt isn't evidence that it
  failed. Command additions, removals or state changes can wake it.
- Unsaved switches keep their mode, order and occurrence in the owner until
  retried or withdrawn, because those facts can't survive refused browser storage.
- Pane disposal fences only that pane's recovery session. Account disposal
  invalidates admissions.

Deferred work: [TODO](TODO).
