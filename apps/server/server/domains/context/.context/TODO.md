# domains/context — local debt

## Batch revision availability lookups

`document-revisions.ts` `current` calls `availability.lookup` once per
document, though the port accepts a `documentIds` batch. Unmeasured; batch it
if C5b's per-turn revision checks show the round trips.
