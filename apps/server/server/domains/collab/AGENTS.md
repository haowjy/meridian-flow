# domains/collab — server-side branch collaboration

This domain composes `@meridian/agent-edit` with Meridian persistence and
Hocuspocus transport. The durable model is branch-based: live documents,
thread-peer branches, and work-draft branches are all real Y.Docs with sync-only
propagation between them.

## Mental model

- **Live document** is the canonical Yjs journal (`document_yjs_updates`).
- **Thread peer** is the agent's per-thread branch. Agent-edit writes there, not
  directly to live, and each write is pushed into the Work draft journal.
- **Work draft** is the writer-review branch for a Work. Review compares the
  work-draft Y.Doc with live and pushes/discards selected journal rows.
- **Journal is the durable record.** Runtime state is memory-only; restarts cold
  reconstruct from the live journal plus branch state/journal rows.
- **Document authority is fenced.** Each live document has a durable authority
  identity, generation, and contiguous admission sequence.
- Checkpoint restore replaces the authority generation. It never applies checkpoint
  bytes to the current Y.Doc; the transport fences each connection to its opened
  generation and rejects retired-identity insertion or delete-set replay.
- **Safety provenance is journal-derived.** Ordinary prose birth class comes
  from authenticated journal attribution. Certified semantic mutations may add
  sparse continuation/restoration facts in the reserved Yjs provenance types,
  atomically with their prose update; ordinary authorship adds no reserved fact.
- **Closure means card review.** `branch-review-closure.ts` computes
  journal-backed closure classes so review cards apply/discard coherent sets.

## What lives here

- `domain/document-authority.ts` is the sole content-admission policy capability:
  it validates fresh authorship, certified semantic edits, frozen-cut identity
  replication, and fenced snapshot replacement before persistence; push planning
  and settlement remain owned by their transition modules.
- Branch pulls and certified thread-peer commits enter that capability through the
  branch coordinator adapter; response-transaction persistence remains one durable unit.
- `composition.ts` wires package core, live journal/coordinator, branch stores,
  branch pull/push, Hocuspocus, checkpoints, and route-facing facades.
- `domain/branch-critical-sections.ts` owns branch/document lock ordering;
  `branch-push-plan.ts` owns materialization, `branch-push-preparation.ts` owns
  immutable-base Manual Apply policy, and `branch-trail-projection.ts` owns
  trail/notice projection. `branch-push-executor.ts` owns orchestration;
  `branch-push-transition.ts` is the sole ordering owner for capture, prepare,
  born-owned commit, settlement, fenced apply/completion, and recovery across
  every push mode. `branch-review*.ts` owns discard/undo/redo.
- `domain/ports/change-trail-persistence.ts` is the persistence boundary.
  `adapters/drizzle-change-trail-aggregate.ts` is the only aggregate writer;
  dispatcher, work processor, and reconciler remain separate lifecycle owners.
- `domain/draft-review-*` is the review diff/presentation pipeline over branch
  docs. The name is UI vocabulary; it is not the old persisted draft subsystem.
- `adapters/drizzle-*` are production persistence adapters for live journal,
  branches, branch pushes, turn lineage, receipts, and Hocuspocus coordination.

## Rules

- Do not reintroduce `document_yjs_drafts`, draft-scoped agent-edit state,
  `scope_id`, accept/reactivation lifecycle, or draft Hocuspocus rooms.
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
- **Undo is intrinsically guarded**: live `persistUndo` runs the dependency
  check under `lockDocumentMutation`; Draft reversal commits reject any branch
  journal advance after planning under the branch snapshot CAS.
- **Draft write undo is generation-local**: a response/document folds to one
  durable handle; undo/redo stages a typed-generation system row and projects it
  in the same Work-draft commit. Never delegate an active Draft generation to
  live reversal persistence. One command pins its branch authority through
  persistence; reconstruction finishes from the authoritative branch state so
  selectively reviewed rows cannot reappear. Persistence fences both appended
  rows and status-only Apply/review transitions.
- **All branch Y.Docs are `gc: false`**: delete sets are preserved; tombstones
  are never cleaned. The undo dependency predicate depends on full struct history.
- **Push lock ordering**: `BranchCriticalSections` acquires sorted branch locks
  (per `branchId`) then sorted live document coordinator locks. Never bypass it
  or reverse this order.
- **Draft Apply safety is row-based**: each draft journal row owns an immutable
  live-journal `draftBaseUpdateSeq`; manual Apply refuses human divergence or
  resurrection after that base. Auto-apply never gates and trails only effects
  that destroy writer-owned roots according to durable provenance.
- **Agent destruction is report-only**: ordinary Yjs merge always commits.
  Echo informs the agent; writer-lineage sweeps are captured for the trail and
  Restore; agent-only destruction is silent.
- **Reversal availability is dependency-based**: canonical dependency checks may
  refuse a lossy undo. Destructive effects from an allowed agent reversal are
  reported without changing the reversal outcome.
- **The coordinator lock does not exclude WebSocket mutations.** A
  reporting-relevant live apply after an `await` must snapshot-diff the live Y.Doc
  and apply in the same synchronous block. Response phase C and branch push
  enforce this; reversal `executePrepared` snapshots around persistence and uses
  the same final synchronous recheck-and-apply seam.
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
