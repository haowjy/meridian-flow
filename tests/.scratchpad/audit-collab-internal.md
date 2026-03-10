# Audit: Collab Internal Consistency (gpt-5.4, p23)

## Concurrency

- **HIGH** `session_manager.go:113,126,77` — `Release` removes the last live session before `flushOnDisconnect` runs. A new `Acquire` in that window rebuilds from stale persisted state, so the newly active session can regress the document and later overwrite newer data.

- **HIGH** `proposal_service.go:211,231,299,390` — Accept paths apply the Yjs update before the terminal status transition, but `RejectProposal` is outside the same document gate and `GroupAccept` converts some post-apply failures into "skipped" outcomes. A proposal can end rejected or skipped while its update has already mutated runtime state.

- **HIGH** `collab_snapshot.go:281`, `session_manager.go:200,390` — Snapshot restore only updates persisted state. Open documents keep serving stale in-memory state and can flush that stale state back over the restored version.

- **MEDIUM** `subscription_service.go:119,171` — `Subscribe` publishes a placeholder before `Acquire` and broadcaster registration complete. A racing `UnsubscribeAll` can remove that placeholder first, leaving an orphaned session/broadcaster with no tracking entry.

## Yjs State Lifecycle

- **HIGH** `session_manager.go:390`, `ai_content_projector.go:84`, `collab.go:31` — Live-session persists always store `ai_content = content`, which destroys the projector's intended `base + pending proposals` view on the next debounce or disconnect flush.

- **HIGH** `collab_snapshot.go:116,283` — `CreateSnapshot` bootstraps empty `yjs_state` from content, but `RestoreSnapshot` does NOT bootstrap when creating the pre_restore safety snapshot. For REST-created docs, that safety snapshot can be empty.

- **HIGH** `collab_snapshot.go:224,295` — Snapshot decode failure is a hard error for read APIs, but restore logs and continues, then writes blank text projections next to the unreadable Yjs blob.

- **MEDIUM** `ai_content_projector.go:58,100` — `Recompute` and `BuildProjectedState` disagree on how empty `yjs_state` should be bootstrapped.

## Pattern Inconsistencies

- **MEDIUM** `collab_project.go:159,279` — `doc:subscribe` strictly validates and canonicalizes `documentId`, but `doc:unsubscribe` can acknowledge malformed IDs without removing the real subscription.

- **LOW** `collab_proposal.go:175,272` — `proposal:accept` replay is surfaced as error, while `proposal:groupAccept` replay follows normal success path. Same idempotency concept, different WS contract.

## Interface Contract Violations

- **MEDIUM** `collab_snapshot.go:301`, `document_store.go:81` — Restore calls `SaveState(..., restoredContent, "")`, but `LoadAIContent` only falls back when `ai_content` is NULL, not empty string. Restored projected reads go blank.

- **LOW** `session_manager.go:143,262` — `ProposalRuntime.ApplyUpdate` accepts caller-supplied `origin` but ignores it, always records `lastOrigin = "ai_accept"`.

## Dead/Vestigial Code

- **LOW** `document_touch.go:5` — `DocumentTouch` model defined but unused.
- **LOW** `document_resolver.go:31` — Comment says "not called yet" but authenticator depends on it.
