# domains/collab — server-side branch collaboration

This domain composes `@meridian/agent-edit` with Meridian persistence and
Hocuspocus transport. The durable model is branch-based: live documents,
thread-peer branches, and work-draft branches are all real Y.Docs with sync-only
propagation between them.

## Mental model

- **Live document** is the canonical Yjs journal (`document_yjs_updates`).
- **Thread peer** is the agent's per-thread branch. Agent-edit writes there, not
  directly to live, and each write is pushed into the Work draft journal.
- **Work draft** is the single writer-review branch for one document and Work.
  Every thread peer in that Work pushes into the same branch. Review compares
  its Y.Doc with live. Apply pushes the whole current branch; Discard may reverse
  selected journal rows. Turns are not independent physical drafts.
- **Journal is the durable record.** Runtime state is memory-only; restarts cold
  reconstruct from the live journal plus branch state/journal rows.
- **The durable authority head is fenced.** Each live document has one durable
  authority identity, generation, and contiguous admission sequence.
- Checkpoint restore replaces the durable authority generation. It never applies
  checkpoint bytes to the current Y.Doc; the transport fences each connection to
  its opened generation and rejects retired-identity insertion or delete-set replay.
- **Reserved provenance is for direct-write safety, not sweep.** Ordinary prose
  safety attribution comes from the authenticated journal. Certified semantic
  mutations may add sparse continuation/restoration facts in reserved Yjs
  types. Branch-settlement sweep uses recipient-native writer lineage intervals
  instead.
- **Discard class means card review.** `branch-review-closure.ts` joins
  operations only through shared discard rows and hunks, then vends the required
  class identity. The client never reconstructs classes. Apply is
  document-scoped and publishes the whole current branch.

## Rules

- Keep package imports one-way: server adapters import `@meridian/agent-edit`;
  the package must not import server code.
- Novel live Hocuspocus writer updates append to the journal in `beforeSync`,
  using Hocuspocus's already-decoded sync type and payload, before Yjs
  apply/broadcast/ack; already-contained reconnect frames are acknowledged
  without admission. Branch updates persist through the branch coordinator.
  Connection updates do not fire document activity/projection hooks.
- Branch-room writer updates validate and commit through the branch coordinator
  against one locked branch snapshot in `beforeSync`, before Hocuspocus
  apply/broadcast/ack; already-contained reconnect frames are acknowledged
  without another journal row. `onChange` is not a branch durability seam.
- Live and branch writer frames share one admission order: validate authority
  and generation, acknowledge exact containment, validate fresh authorship,
  then append durably.
- Client admission must reject reserved client IDs and any insertion/deletion in
  the reserved provenance namespace before journal/apply/broadcast/ack.
- Settlement changes require all three verification layers: the durable-only
  killed-process oracle, a real production-composition PostgreSQL/Hocuspocus
  harness using production-shaped sync updates, and writer-visible release probes.
  Passing fixture-shaped oracle cases alone is not release evidence.
- Live sync-step-2 updates run journal-attributed offline reconciliation after
  the update is durable; ordinary post-connect edits do not run that path.
- `readAsMarkdown` reads the coordinator-owned live/persisted Y.Doc. Branch-aware
  reads go through `readEffectiveMarkdown` / `readEffectiveHashlines`.
- **Live reversal has one planner authority**: receipt availability and command
  execution both use agent-edit `planUndo` / `planRedo`; `persistUndo` and
  `persistRedo` repeat the plan watermark guard under `lockDocumentMutation`.
  Freshness is writer-owned: later human rows stale the plan, while system
  reversal/bookkeeping and agent rows do not. Draft reversal remains a separate
  generation-local authority: `branch-turn-reversal-plan.ts` prepares both
  receipt availability and command execution, while the branch snapshot CAS
  rejects advances after planning.
- **Work-draft write reversal is generation-local**: a response/document folds to one
  durable handle; undo/redo stages a typed-generation system row and projects it
  in the same Work-draft commit. Never delegate an active Draft generation to
  live reversal persistence. One command pins its branch authority through
  persistence; reconstruction finishes from the authoritative branch state.
  Persistence fences both appended rows and status-only reversal/review
  transitions.
- **All branch Y.Docs are `gc: false`**: delete sets are preserved; tombstones
  are never cleaned. The undo dependency predicate depends on full struct history.
- **Push lock ordering**: `BranchCriticalSections` acquires sorted branch locks
  (per `branchId`) then sorted live document coordinator locks. Never bypass it
  or reverse this order.
- **Draft Apply settles the whole current branch**: every writer Apply and
  auto-push integrates through Yjs. Writer rows created after preview are
  included with their actor attribution. The final reconciliation row carries
  the complete pushed update for causal replay coverage; authored rows remain
  the attribution and dependency records. Settlement sweep policy treats each
  agent row's `draftBaseUpdateSeq` as that candidate's own observation
  watermark and elevates a live-session mark only for a receiving writer whose
  later edit that candidate overwrote. Unknown, historical, AI, and
  other-writer roots are ordinary for that recipient. Compact per-writer root
  evidence preserves first admission when sync updates repeat old structs, is
  evaluated by neutral interval operations, and is delivered only to
  authenticated connections; it never changes the durable receipt or vetoes a
  push.
- **Agent destruction is report-only**: ordinary Yjs merge always commits.
  Echo informs the agent; swept changes elevate ephemeral marks. Trail evidence
  and peer-mark popovers remain read-only; receipt Undo/Redo is the sole
  reversal authority for AI changes. Agent-only destruction is silent.
- **Reversal availability is dependency-based**: canonical dependency checks may
  refuse a lossy undo. Destructive effects from an allowed agent reversal are
  reported without changing the reversal outcome.
- **Cross-scope reversal is durable-atomic and runtime-staged**: branch and live
  durability share one transaction; branch broadcasts, live Y.Doc application,
  runtime synchronization, and projection refresh run after it commits, with
  per-document journal recovery. Rollback must leave every process-local
  projection untouched.
- **The coordinator lock does not exclude WebSocket mutations.** A
  reporting-relevant live apply after an `await` must snapshot-diff the live Y.Doc
  and apply in the same synchronous block. Response phase C and branch push
  enforce this; reversal `executePrepared` uses the same final synchronous
  recheck-and-apply seam, inline or after transaction commit.
- All seed and text-write callers use `domain/markdown-document.ts`; it resolves
  filetype and constructs content for the document's actual schema. The
  markdown-only seeding that caused #196 is historical, not the current engine.

## Diagnostic anti-patterns

- **`documents.markdown_projection` is not the persistence authority.** The
  projection column and `documents.updated_at` update asynchronously (on
  store/checkpoint, not per keystroke). Verifying edit persistence requires
  querying `document_yjs_updates` (the live journal). A stale projection with a
  healthy journal is normal operation, not a persistence failure. See
  [#241](https://github.com/haowjy/meridian-flow/issues/241) for the
  investigation into making this less misleading.
- **Server logs are silent on the collab success path.** A fully successful
  edit-and-persist flow emits zero server log lines and zero HAR-visible
  requests. Browser network tooling (HAR, `agent-browser`) does not expose
  WebSocket traffic. Proving persistence currently requires direct journal
  queries. Success-path wire events are tracked in
  [#239](https://github.com/haowjy/meridian-flow/issues/239).

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`domains/notices/AGENTS.md`](../notices/AGENTS.md)
→ [`packages/agent-edit/AGENTS.md`](../../../../../packages/agent-edit/AGENTS.md)
