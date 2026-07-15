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
- **Closure means card review.** `branch-review-closure.ts` computes
  journal-backed closure classes so review cards apply/discard coherent sets.

## What lives here

- `composition.ts` wires package core, live journal/coordinator, branch stores,
  branch pull/push, Hocuspocus, checkpoints, and route-facing facades.
- `domain/branch-critical-sections.ts` owns branch/document lock ordering;
  `branch-push-plan.ts`, `branch-trail-projection.ts`, and
  `branch-push-executor.ts` own push decisions, trail projection, and the single
  durable execution path. `branch-review*.ts` owns discard/undo/redo.
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
- Hocuspocus connection updates append to the live journal or branch coordinator;
  connection updates do not fire document activity/projection hooks.
- Live sync-step-2 updates run journal-attributed offline reconciliation after
  the update is durable; ordinary post-connect edits do not run that path.
- `readAsMarkdown` reads the coordinator-owned live/persisted Y.Doc. Branch-aware
  reads go through `readEffectiveMarkdown` / `readEffectiveHashlines`.
- **Undo is intrinsically guarded**: `persistUndo` runs the dependency check
  in-transaction under `lockDocumentMutation`. There is no separate guard to
  bypass — every undo path passes through the same gate.
- **All branch Y.Docs are `gc: false`**: delete sets are preserved; tombstones
  are never cleaned. The undo dependency predicate depends on full struct history.
- **Push lock ordering**: `BranchCriticalSections` acquires sorted branch locks
  (per `branchId`) then sorted live document coordinator locks. Never bypass it
  or reverse this order.
- **Destructive-write gate is human-only**: the safety gate intersects
  `deletedHashes` against concurrent HUMAN-origin touched hashes only.
  Agent-origin concurrent edits do not trigger rejection.
- **Reversal safety has two axes**: canonical dependency checks govern availability;
  agent reversals independently require their authoring response observation snapshot.
- **The coordinator lock does not exclude WebSocket mutations.** A
  safety-relevant live apply after an `await` must snapshot-diff the live Y.Doc
  and apply in the same synchronous block. Response phase C and branch push
  enforce this; reversal `executePrepared` snapshots around persistence and uses
  the same final synchronous recheck-and-apply seam.
- All seed and text-write callers use `domain/markdown-document.ts`; it resolves
  filetype and constructs content for the document's actual schema. The
  markdown-only seeding that caused #196 is historical, not the current engine.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`domains/notices/AGENTS.md`](../notices/AGENTS.md)
→ [`packages/agent-edit/AGENTS.md`](../../../../../packages/agent-edit/AGENTS.md)
