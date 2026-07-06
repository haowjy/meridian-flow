# collab — server-side document infrastructure

The Yjs editing engine lives in `@meridian/agent-edit` (`packages/agent-edit/`).
This server domain supplies concrete persistence/transport adapters and exposes a
`CollabDomain` for context, upload, route, and WS callers.

## Current shape

| Concern | Location | Status |
|---|---|---|
| Tool core (`write()`, undo/redo, compaction) | `@meridian/agent-edit` | Extracted package |
| Codec/model factories | `@meridian/agent-edit` + `@meridian/prosemirror-schema` | Composed by server |
| Application-facing collab domain | `collab/index.ts`, `collab/composition.ts` | Facade wiring over package codec/model plus journal/coordinator |
| Agent write branch binding | `collab/domain/branch-agent-edit.ts` | Thread-peer write core with per-write work-draft push |
| Full-document markdown SET/read | `collab/domain/markdown-document.ts` | Server-side engine over package primitives; not package public API |
| Journal/mutation persistence | `collab/adapters/drizzle-journal.ts` | Production `UpdateJournal` with mutation queries, lifecycle, checkpoint, and latest-update helpers |
| Live-doc coordination | `collab/adapters/hocuspocus-coordinator.ts` | Production `DocumentCoordinator` |
| Hocuspocus load | `collab/adapters/document-loader.ts` | Rebuilds Y.Doc state from journal |
| In-memory app/test adapters | `collab/adapters/in-memory/agent-edit.ts` | Real in-memory journal/coordinator/lifecycle |
| Document write read models | `collab/domain/document-activity.ts` | Production post-write hook for activity/projection |
| Turn live-lineage read-model | `collab/domain/turn-live-lineage.ts` + `adapters/drizzle-turn-live-lineage.ts` | Footer authority over live agent-edit mutations |

## Domain behavior

### Full-document SET

`writeFromMarkdown` and `writeDocument` intentionally do not add a package
`set` command. `domain/markdown-document.ts` parses markdown with the package
codec, clones the live Y.Doc into a draft, deletes the ProseMirror fragment
contents, inserts the parsed blocks through the package model, appends the
resulting Yjs update to the journal, then applies that update to the live doc.
Mutating the draft before append keeps the live doc from advancing if
persistence fails.

After a full-document write has appended to the journal and applied to the live
Y.Doc, `setMarkdown` / `editMarkdown` fire the injected document-write hook. The
production hook updates document activity rollups and `documents.markdownProjection`.
It is awaited so callers see fresh read models when the hook succeeds, but hook
failures are logged through `EventSink` and do not fail or roll back the
committed journal write.

### Reads

`readAsMarkdown` is a thin codec/model read under `DocumentCoordinator` access.
It serializes raw markdown without block-hash view prefixes.

### Lifecycle

`createServerDocumentLifecycle.ensureDocument(docId)` upserts the
`document_yjs_heads` row and creates an empty Yjs checkpoint when the journal has
no state. The Yjs tables FK to `documents.id`; callers are expected to create the
`documents` row before ensuring collab state.

`document_yjs_heads.latest_checkpoint_id` is a Drizzle-declared FK to
`document_yjs_checkpoints.id` (`ON DELETE SET NULL`). In production, checkpoints
are append-only: compaction deletes retained update rows, not checkpoint rows, and
checkpoints disappear with their parent document cascade. The `SET NULL` action is
a defensive database behavior, not an ordinary lifecycle path.

**Stale-schema guard (invariant).** `document_yjs_heads.schema_version` is stamped
with the running `COLLAB_SCHEMA_VERSION` on every head upsert, but upsert uses a
monotonic `greatest(stored, current)` assignment so a downgraded server cannot
stamp the head backward and erase the fence. The journal read path refuses to
replay bytes from an older schema: `journal.read()` (and thus
`loadDocumentState`, the cold-open `persistedState`, and `recover`) calls
`assertReadableHead` and throws `StaleDocumentSchemaError` when the stored version
is behind. This converts silent y-prosemirror corruption on a schema bump into a
loud, detectable failure. The rule is explicit, not incidental: `ensureDocument`
must `assertReadableHead` **before** `upsertHead` — stamping the current version
first would erase the evidence and silently disable the guard.

Recovery/rebuild from a trusted source on a stale version is deferred to
[#94](https://github.com/haowjy/meridian-flow/issues/94); the guard only blocks.
The guard is still one-sided: a server older than the stored head version preserves
the newer fence but does not reject replay. Rejecting newer-than-current heads is
tracked in [#95](https://github.com/haowjy/meridian-flow/issues/95) because it
needs a rollout compatibility decision.

### Origin translation

Public origins remain collab-shaped:

- `{ type: "agent", actorTurnId }` → `agent:<turnId>` with `actorTurnId`
- `{ type: "user", userId/actorUserId }` → `human:<userId>`
- `{ type: "import", userId, ... }` → `human:<userId>`; userless imports map to
  `system`
- `{ type: "system" }` → `system`

Attribution maps package `human:<userId>` back to API `originType: "user"`.

### Hocuspocus persistence

The WS route calls the collab domain hooks:

- `loadHocuspocusDocument` replays checkpoint + updates via `loadDocumentState`.
- `persistConnectionUpdate` appends the connection update to the journal outside
  the coordinator; pending appends are tracked by document. It first rejects any
  update carrying a struct in the reserved clientID band (see below): the update
  is dropped and the document is flagged unsafe-for-checkpoint.
- `storeHocuspocusDocument` drains pending appends for that document, captures
  the latest persisted update seq, then writes a checkpoint from
  `Y.encodeStateAsUpdate(document)`. The seq is captured before encoding so a
  concurrent append is replayed instead of hidden by the checkpoint.
- `drainHocuspocusPersistence` waits for tracked appends. Metrics report pending
  depth, oldest pending age, failed/dropped append count, live docs, and open
  Hocuspocus connections.
- Connection-update appends are collaborative keystroke persistence, not
  document-level write events, so they do not fire the activity/projection hook.

### Reserved Yjs clientID band

Yjs identifies CRDT items by `(clientID, clock)`; two writers sharing a clientID
corrupt the doc permanently. The band `[0, RESERVED_CLIENT_ID_MAX]` (999, defined
in `@meridian/prosemirror-schema`) is reserved for **server-authored reversal**
writing — `composition.ts` injects `AGENT_EDIT_UNDO_CLIENT_ID` (999) into the
agent-edit write tool. Two invariants keep the band exclusive:

- **No live writer draws into the band.** Every content-authoring `Y.Doc` (the
  browser editor and all server adapters) is built via `createCollabYDoc()`,
  which re-rolls any clientID `<= 999`. agent-edit stays host-agnostic: its
  forward runtime docs come from an injected `createRuntimeDoc` factory wired to
  `createCollabYDoc` at this composition root.
- **Inbound band updates are rejected at ingest.** `persistConnectionUpdate`
  drops any connection update with a struct in the band and marks the doc
  unsafe-for-checkpoint, so a forged/misbehaving client can't collide with the
  reversal stream.

Reversal is served entirely by cold reconstruction (no live `Y.UndoManager`).
Cold-reconstruction latency stays interactive because checkpoint freshness is
maintained by Hocuspocus's debounced store (`debounce: 2000, maxDebounce: 10000`
in the WS route) — a checkpoint every ≤10s of active editing bounds the replay
window.

## Stable server-side helpers

### Turn live-lineage read-model

`domain/turn-live-lineage.ts` is the server-owned authority for which documents a
turn has durably changed in live state. The Drizzle adapter reads distinct
documents from live `agent_edit_mutations` for `(threadId, turnId)` and filters to
the live scope inside the adapter. Higher layers call
`listLiveDocumentsForTurn(threadId, turnId)` and receive document ids + canonical
context URIs; they never pass or branch on raw `scope_id`. Draft-only mutations do
not appear. Applying a draft stamps the live `draft-accept:*` mutation with the
draft's originating assistant turn (`document_yjs_drafts.last_actor_turn_id`), so
the transcript Undo belongs to the proposal turn and routes draft-accept writes
through draft reactivation instead of raw live reversal.

### Turn-reversal orchestration (`domain/turn-reversal.ts`)

`reverseTurn` iterates every document a thread turn touched (queried via
`ReversalStore.documentsForTurn`) and calls `agentEdit.reverse()` per document
with a `{ kind: "turn", turnId }` selection. The per-document outcome is
enriched with a context URI via `resolveDocumentUri`; the aggregate status is
`reversed`/`reconciled` when all documents succeed, `nothing_to_undo`/
`nothing_to_redo` when none have reversible writes, `expired`, or `partial`.

`TurnReversalAccess` (`index.ts:78`) exposes this as `reverseTurn(input)` on
`CollabDomain`. Route handlers also call `agentEdit().reverse()` directly when
the caller specifies a single document URI.

**Reverse route** — `routes/api/threads/[threadId]/context/reverse.post.ts`
accepts `{ uri?, direction, scope, target? }`. Without a `uri`, it calls
`documentSync.reverseTurn()` for the whole turn. With a `uri`, it resolves the
single document and calls `agentEdit().reverse()` directly.

### Undo-notification delivery

The collab composition adapts agent-edit's
`UndoNotificationPort` to a server-side `PendingUndoNotificationRepository`
(`domains/undo-notifications/`). After a successful user reversal, the port
resolves `docId` to a context URI and writes a row to `pending_undo_notifications`.
The runtime orchestrator consumes these rows once at `runTurn` start to inject
net undone edits into the first model request. Coalescing by write handle
(last direction wins) lives in the undo-notifications repository.

`document-activity.ts` contains DB helpers for document write read models:
`touchDocumentActivity` and `updateMarkdownProjection`. `createCollabDomain`
wires them through the facade document-write hook; the in-memory collab domain
passes no hook.

## Draft review subsystem

→ Full details in [`.context/draft-review.md`](draft-review.md).

Summary: AI agent edits in draft mode are routed to a per-work draft (isolated
Yjs deltas) instead of the live document. Accept merges deltas into a single
journal entry (`writeId=draft-accept:<id>:<accept_generation>`); reject discards. Both are undoable
within 24 hours. Undo-accept claims a non-appendable `reactivating` slot, reverses
live accepts, then atomically republishes the preserved draft rows as `active`. Write mode
is owned by the Work and resolved from `works.ai_write_mode` at write time. The
`scope_id` column partitions durable agent-edit journal state (sentinel `"live"`
vs draft ULID) between live and draft cores; runtime sync state is not durable.
Reactivated accept is proof-only: a base block can
match current live only by durable Yjs id or by content that is globally unique
on both sides. Duplicate-content or otherwise ambiguous reactivation placement
fails closed to `cannot_place`; the server must not use positional same-content
anchors.

UI surfaces (shipped in PR #125): `DraftReviewCard` (per-draft chat-anchored
cards), `DraftReviewBar` (in-editor review bar), `DraftReviewProvider` (shared
controller at project shell), `DraftIndicatorChip` (cross-thread discoverability).
All share one server-backed draft state via `listReviewableDrafts`.

The terminal `cannot_place` UX contract (dead-card banner, no Apply, Copy+Discard
only) is a KB decision: [terminal-cannot-place-ux.md](../../../../../../../.meridian/git/haowjy-meridian-flow-docs/kb/decisions/terminal-cannot-place-ux.md).

## Deferred cutover work

- Keep schema-parity and TipTap extension work in the package cutover plan.

## Undo/Redo Model — Decisions and Open Questions

### Current model
Turn-level, CRDT-based. Undo creates a new Yjs update that reverses a turn's
writes. Redo creates a new update reversing the undo. Linear stack per document
per thread (not branching).

### Branching undo tree (Vim/Emacs-style)
**Open question.** In Vim (`undotree`) and Emacs (`undo-tree-mode`), undo → edit
→ redo preserves all history branches. Our current model is linear: editing after
undo may discard the redo target. Since Yjs undo is CRDT-composed (undo/redo are
new updates, not history rewrites), undo → edit → redo may produce merged results
rather than clean redo — CRDT conflict resolution decides the merge, which may
feel "mangled" to the writer.

**Human decision (2026-06-29):** "Mangling the document after undo/redo is
probably okay if you knowingly made an edit in between." The user accepts that
editing after undo may produce imperfect redo results. A branching undo tree is a
tracked future enhancement, not a current blocker.

**Context:** see related GitHub issue (likely #86 or linked from #122).

## Multi-Draft Support

**Invariant to preserve:** Do not close doors on having multiple drafts within
the same thread. The current backend enforces one active draft per
(documentId, workId), but the client grouping model (`ThreadDraftGroup.drafts:
ThreadDraftListItem[]`) is intentionally array-shaped to keep this option open.
The unique partial index on `document_yjs_drafts` is the constraint to relax if
multi-draft support is added.

**Human decision (2026-06-29):** Keep the multi-draft-ready shape in the client
types. Do not simplify `ThreadDraftGroup.drafts` to a single item, even though
reviewers flagged it as speculative. This is intentional future-proofing.

## Branch peer shadow layer

S1 branch peers are server-owned `Y.Doc`s with `gc: false`, persisted in
`document_branches` as full update snapshots. `domain/branch-coordinator.ts` is
the single mutation gate for branch snapshots: it materializes the branch doc,
runs the mutation under a per-branch `KeyedMutex`, persists the new full state
with a generation + state-vector CAS, and retries from a reloaded snapshot on CAS
failure. Branch propagation must call `sync(from, to)` from `branch-sync.ts`; do
not apply custom deltas between peers.

`adapters/drizzle-branches.ts` owns branch provisioning. Work drafts seed from
the live doc; thread peers seed from the work draft. This preserves the I4
failure mode: a missing peer is provisioned from a non-empty upstream, never from
an empty fallback. Live-to-work pulls are scheduled by Hocuspocus persistence
after the live journal append settles; work-to-thread pulls are exposed as a
server callable and remain unused by agent tools until the S2 valve opens.

`domain/branch-push.ts` owns durable-first work-draft -> live pushes: compute
without locks, commit the live journal/lineage first, apply under the live
coordinator after commit, then return client invalidation metadata. Auto-policy
branches reset from the post-push live doc only when the caller's branch snapshot
is still current, so a concurrent append can block compaction instead of being
wiped out. S2's per-write path attaches to the `pushAutoBranchAfterThreadPeerWrite`
seam at GATE-2.

**Branch schema-version invariant.** `document_branches.schema_version` is the
schema version of that persisted branch snapshot. Work drafts copy the live
`document_yjs_heads.schema_version` when they seed from live; thread peers copy
their upstream work draft; resets copy the reset source. Branch materialization
checks the branch row's version and throws `StaleDocumentSchemaError` when it is
behind the running schema. Do not derive branch readability from the current live
head: a branch may contain older snapshot bytes after live has migrated. Manifest
identity documents fall back to the current schema only when no live head exists,
because their S1 manifest doc is rebuilt from the `documents` projection.

**Manifest peer shadowing.** The live manifest is a hidden `documents` row with
`kind = 'manifest'`; its `Y.Map("documents")` holds manuscript document ids with
`{ present: true }`. S1 keeps SQL membership and manifest membership equal while
the valve is closed. ContextFS create/delete paths call the collab shadow hooks
(`recordManifestDocumentCreated` / `recordManifestDocumentDeleted`) for the
`manuscript` scheme only; S2 moves agent consumers to the manifest branch.
