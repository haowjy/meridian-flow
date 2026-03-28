# Phase 5: Proposal Persistence + Offline Review

## Goal

Persist AI proposals locally, derive grouped review hunks from the canonical Yjs document plus pending proposal updates, and make accept/reject work offline with queued server sync.

## Dependencies

- Phase 2 complete
- Phase 4 complete
- Phase 3 complete for the primary tabbed/editor verification flows

## Parallelism

- `P5.1` can begin once the Dexie schema from Phase 2 is stable.
- `P5.2` depends on `P5.1`.
- `P5.3` depends on `P5.2`.

## Step Summary

| Step | Outcome | Risk | Recommended model |
|---|---|---|---|
| P5.1 | Proposal repository and queue runtime on top of Dexie | Medium | `gpt-5.3-codex` |
| P5.2 | Diff derivation and grouped hunk model from Yjs clones | High | `gpt-5.4` |
| P5.3 | Offline accept/reject actions, decoration wiring, and review stories | High | `gpt-5.4` |

### Step P5.1: Build The Proposal Store Runtime

**Scope and intent**

Turn the raw Dexie tables from Phase 2 into a usable runtime that can persist inbound proposals, expose document-scoped queries, enqueue accept/reject operations, and clear a document's review state on reset/discard.

**Files to create or modify**

- `frontend-v2/src/editor/proposals/proposal-store.ts`
- `frontend-v2/src/editor/persistence/editor-db.ts`
- `frontend-v2/src/editor/proposals/proposal-store.test.ts`

**Interface contracts**

```ts
export interface ProposalStore {
  listByDocument(documentId: string): Promise<PersistedProposal[]>
  putProposal(proposal: PersistedProposal): Promise<void>
  setStatus(
    proposalId: string,
    status: ProposalStatus,
    acceptedAtOffset?: number | null,
  ): Promise<void>
  enqueueStatusChange(op: QueuedProposalOp): Promise<void>
  listQueuedOps(documentId: string): Promise<QueuedProposalOp[]>
  clearDocument(documentId: string): Promise<void>
  subscribe(listener: () => void): () => void
}
```

**Patterns to follow**

- Keep the repository unaware of CM6 and decorations.
- Make clearing a document idempotent so invalidation/reset flows can call it defensively.

**Constraints and boundaries**

- No diff logic here.
- No UI logic here.

**Verification criteria**

- Incoming proposals survive page reload.
- Queued accept/reject ops persist independently of proposal records.
- `clearDocument()` removes both proposal rows and queued ops for one document.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f .meridian/work/v1-launch/features/collab/frontend-diff-model.md
-f frontend-v2/src/editor/persistence/editor-db.ts
```

### Step P5.2: Implement Projection And Hunk Derivation

**Scope and intent**

Build the runtime that clones the canonical Yjs doc, applies proposal updates, derives hunks, groups them by overlap/proposal atomicity, and marks stale proposals correctly.

**Files to create or modify**

- `frontend-v2/src/editor/proposals/diff-model.ts`
- `frontend-v2/src/editor/proposals/hunk-model.ts`
- `frontend-v2/src/editor/proposals/diff-model.test.ts`

**Interface contracts**

```ts
export interface DerivedHunk {
  id: string
  documentId: string
  from: number
  to: number
  kind: "insertion" | "deletion" | "replacement"
  insertedText: string
  proposalIds: string[]
}

export interface ProposalProjectionResult {
  sequence: number
  hunks: DerivedHunk[]
  staleProposalIds: string[]
}

export function deriveProposalHunks(args: {
  ydoc: Y.Doc
  proposals: PersistedProposal[]
  currentUserId: string
}): ProposalProjectionResult
```

**Patterns to follow**

- Follow `.meridian/work/v1-launch/features/collab/frontend-diff-model.md` exactly for clone/apply/diff/group behavior.
- Use text pre-check stale detection before applying proposal updates to the projection clone.

**Constraints and boundaries**

- Do not mix transport receipt logic into the diff model.
- Keep grouped hunk identity stable enough for CM6 decoration remapping.

**Verification criteria**

- Unit tests cover non-overlapping edits, overlapping edits, multi-paragraph proposals, stale detection, and grouped hunk transitive closure.
- Re-derive results include `acceptedAtOffset` handling and can mark proposals stale/unstale correctly.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/collab/frontend-diff-model.md
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f frontend-v2/src/editor/collab/undo-manager.ts
-f frontend-v2/src/editor/proposals/proposal-store.ts
```

### Step P5.3: Wire Accept/Reject Actions And Storybook Review Flows

**Scope and intent**

Connect the proposal store and derived hunks to editor-side review actions. Accept/reject must mutate local Yjs state immediately, queue the server-side status change, and leave behind Storybook coverage for offline reload and replay.

**Files to create or modify**

- `frontend-v2/src/editor/proposals/proposal-actions.ts`
- `frontend-v2/src/editor/decorations/proposal-hunks.ts`
- `frontend-v2/src/editor/stories/ProposalReview.stories.tsx`
- `frontend-v2/src/editor/collab/undo-manager.ts` if helper exports are needed for discrete action capture

**Interface contracts**

```ts
export interface ProposalActionRuntime {
  getDerivationSequence(): number
  acceptHunk(hunkId: string): Promise<void>
  rejectHunk(hunkId: string): Promise<void>
}
```

Every accept/reject action must:
- call `undoManager.stopCapturing()` before the discrete operation
- use the tracked Yjs origins already defined in `annotations.ts`
- freshness-check the derivation sequence before mutating

**Patterns to follow**

- Keep the proposal review layer separate from live preview decorations.
- Use the existing origin constants in `frontend-v2/src/editor/annotations.ts`.

**Constraints and boundaries**

- Do not block local accept/reject on network availability.
- Do not introduce paragraph-level grouping heuristics beyond the diff-model rules.

**Verification criteria**

- Receive proposal -> reload offline -> proposal still renders.
- Accept offline -> Yjs content changes immediately and queued op persists.
- Reject offline -> proposal disappears locally and queued op persists.
- Reconnect drains queued ops and leaves the local view consistent.
- Storybook covers pending, accepted, rejected, stale, and offline-reload cases.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f .meridian/work/v1-launch/features/collab/frontend-diff-model.md
-f frontend-v2/src/editor/proposals/diff-model.ts
-f frontend-v2/src/editor/proposals/proposal-store.ts
-f frontend-v2/src/editor/collab/undo-manager.ts
-f frontend-v2/src/editor/annotations.ts
```
