# collab FUTURE

## Manifest lifecycle ownership consolidation

Manifest lifecycle is currently split across `composition.ts` (facade calls)
and `adapters/drizzle-branches.ts` (reconciliation + mutation). Caller ordering
can alter domain semantics: the draft-scoped creation regression (commit
`326a5463`) demonstrated that exposing `reconcile` and `record` as
independently sequenced facade calls lets incidental ordering promote
unstaged rows.

**Proposed direction** (investigation p3706): one intent-aware manifest
command owning reconciliation + mutation ordering, so the additive healer
distinguishes a legacy raw row from a not-yet-recorded draft create at the
command boundary rather than via incidental timing. Feeds the pending
efficiency-architecture review alongside #284/#303 gates.

**Affected paths:** `composition.ts`, `adapters/drizzle-branches.ts`

The pending-review correctness boundary no longer depends on that broader
lifecycle consolidation. `domain/work-draft-pending.ts` is the shared
authority for review lists, Work counts, and Auto-apply confirmation. It
classifies `manifest_membership` journal rows as bookkeeping and excludes
branches carrying only those rows, even if their reusable Work-draft branch
record remains `active`. Consolidating who closes or advances manifest branches
is still future work; pending writer UI must not infer prose changes from their
lifecycle status.
