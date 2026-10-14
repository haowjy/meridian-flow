/**
 * The content rebase of a text branch onto live, and the fresh seed of a new one.
 *
 * A text branch's Y.Doc holds two fragments: `prosemirror` (what the writer and the AI edit) and the
 * server-owned `review_base` (live's text as of `base_revision`). The rebase is a three-way content merge
 * of base, live and draft, never a Yjs pull: nothing relates live's items to the draft's. Both
 * fragments are rewritten in one transaction by one dedicated server writer client, then persisted by
 * one branch CAS (`writeBranchState`) together with `base_revision` and `has_effect`.
 *
 * Every caller holds the branch's lease (the pull path, and Apply's catch-up with the leases it owns); the
 * lease lock is not re-entrant, so nothing here acquires it.
 */

import {
  blocksEqual,
  DRAFT_SERVER_CLIENT_ID,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  rebase,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { DraftBaseRevision } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { BranchLockLease } from "./branch-critical-sections.js";

/**
 * The one schema instance behind every PM node the rebase touches: ProseMirror compares node types by
 * identity, so blocks read with one instance and written or merged with another never match.
 */
export const draftSchema = buildDocumentSchema();

/**
 * Live's content and the revision it reflects, read from one durable materialization (S1). The blocks
 * hold at least the revision's edits, never fewer: a revision may lag its content, never lead it.
 */
export type LiveCut = { revision: DraftBaseRevision; blocks: readonly PMNode[] };

/** The one door to live's certified cut. `null` when the document has no durable live state. */
export type LiveCutReader = {
  read(documentId: DocumentId): Promise<LiveCut | null>;
};

/** An Apply settlement that has written live but not yet patched the draft base: it fences the rebase. */
export type BlockingSettlement = { pushId: number; state: "pending" | "blocked"; ageMs: number };

/**
 * `noop` is only for a branch with nothing to do. A refused or failed rebase is never a no-op: `failed`
 * leaves the draft as it was (a deterministic merge failure repeats on the same inputs, so it is not
 * retried until live or the draft changes), and `fenced` names the settlement to wait on.
 */
export type DraftRebaseOutcome =
  | { kind: "rebased"; conflicts: number; orderConflict: boolean }
  | { kind: "noop"; reason: "current" | "no_live" }
  | { kind: "failed"; reason: "base_uninitialized" | "merge_failed" }
  | ({ kind: "fenced" } & BlockingSettlement);

export type DraftRebaseDiagnostics = {
  /** A branch with no review base was refused: rebasing it would read the missing base as empty. */
  uninitializedBase(input: { branchId: string; documentId: DocumentId }): void;
  mergeFailed(input: { branchId: string; documentId: DocumentId }): void;
};

export type DraftRebase = {
  /**
   * Reads live's certified cut, then rebases one text branch onto it under `lease`, which must cover
   * the branch. The cut is read after the lease is held, so it is never older than the lease.
   */
  catchUp(lease: BranchLockLease, branchId: string): Promise<DraftRebaseOutcome>;
};

/** Live's revision `next` supersedes `current`: another authority line, or a later position in it. */
export function revisionAdvances(
  next: DraftBaseRevision,
  current: DraftBaseRevision | null | undefined,
): boolean {
  if (!current) return true;
  if (next.authorityId !== current.authorityId) return true;
  if (next.authorityGeneration !== current.authorityGeneration)
    return BigInt(next.authorityGeneration) > BigInt(current.authorityGeneration);
  return next.seq > current.seq;
}

/**
 * Fresh state for a new text branch: live's text written twice as fresh items by the reserved server
 * client, once into `prosemirror` (the draft) and once into the server-owned `review_base`. The draft
 * shares no Yjs lineage with live: Apply merges by content (contract §2), so only server-authored text
 * and no live client's items are in a new draft.
 */
export function seedDraftState(live: Y.Doc): { state: Uint8Array; stateVector: Uint8Array } {
  const doc = createCollabYDoc({ gc: false });
  try {
    const blocks = readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), draftSchema);
    doc.clientID = DRAFT_SERVER_CLIENT_ID;
    doc.transact(() => {
      writeBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), draftSchema, blocks);
      writeBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), draftSchema, blocks);
    }, "seed");
    return { state: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
  } finally {
    doc.destroy();
  }
}

/** Writes live's text into `doc`'s server-owned `review_base`, as the reserved server client. */
export function writeBaseFrom(
  doc: Y.Doc,
  live: Y.Doc,
  client: number = DRAFT_SERVER_CLIENT_ID,
): void {
  const blocks = readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), draftSchema);
  doc.clientID = client;
  doc.transact(() => {
    writeBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), draftSchema, blocks);
  }, "seed");
}

export function createDraftRebase(deps: {
  branchCoordinator: Pick<BranchCoordinator, "rewriteDraft">;
  liveCut: LiveCutReader;
  /** The oldest pending or blocked Apply settlement of the document, if any (the rebase fence). */
  blockingApplySettlement(documentId: DocumentId): Promise<BlockingSettlement | null>;
  diagnostics?: DraftRebaseDiagnostics;
}): DraftRebase {
  // A branch already reported as uninitialized stays quiet until it initializes: one event per
  // transition, not one per pull.
  const reportedUninitialized = new Set<string>();
  return {
    async catchUp(lease, branchId) {
      return deps.branchCoordinator.rewriteDraft<DraftRebaseOutcome>(
        lease,
        branchId,
        async (doc, snapshot) => {
          const outcome = (result: DraftRebaseOutcome) => ({ result });
          if (!snapshot.baseRevision) {
            if (!reportedUninitialized.has(branchId)) {
              reportedUninitialized.add(branchId);
              deps.diagnostics?.uninitializedBase({ branchId, documentId: snapshot.documentId });
            }
            return outcome({ kind: "failed", reason: "base_uninitialized" });
          }
          reportedUninitialized.delete(branchId);
          // An unfinished Apply has written live but not yet patched this base; merging now would
          // read a base that disagrees with live. The settlement owner reports its own failures once.
          const blocking = await deps.blockingApplySettlement(snapshot.documentId);
          if (blocking) return outcome({ kind: "fenced", ...blocking });
          const live = await deps.liveCut.read(snapshot.documentId);
          if (!live) return outcome({ kind: "noop", reason: "no_live" });
          if (!revisionAdvances(live.revision, snapshot.baseRevision)) {
            return outcome({ kind: "noop", reason: "current" });
          }
          const baseFragment = doc.getXmlFragment(REVIEW_BASE_FRAGMENT);
          const draftFragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
          const base = textBlocks(readBlocks(baseFragment, draftSchema));
          const draft = textBlocks(readBlocks(draftFragment, draftSchema));
          const liveBlocks = textBlocks(live.blocks);
          let merged: ReturnType<typeof rebase>;
          try {
            merged = rebase(draftSchema, base, liveBlocks, draft);
          } catch {
            deps.diagnostics?.mergeFailed({ branchId, documentId: snapshot.documentId });
            return outcome({ kind: "failed", reason: "merge_failed" });
          }
          const mergedBlocks = textBlocks(merged.blocks);
          // A fragment that already holds the result is left alone: rewriting equal text would still
          // replace its items, breaking the ancestry peers and the Yjs-lineage Apply hold with them.
          doc.clientID = DRAFT_SERVER_CLIENT_ID;
          doc.transact(() => {
            if (!blocksEqual(draft, mergedBlocks)) {
              writeBlocks(draftFragment, draftSchema, mergedBlocks);
            }
            if (!blocksEqual(base, liveBlocks)) writeBlocks(baseFragment, draftSchema, liveBlocks);
          }, "rebase");
          return {
            result: {
              kind: "rebased",
              conflicts: merged.conflicts.length,
              orderConflict: merged.orderConflict,
            },
            baseRevision: live.revision,
          };
        },
      );
    },
  };
}

/**
 * An empty document is either no blocks or the one empty paragraph a schema-valid empty doc holds
 * (a fresh live document has the second, a draft seeded before live was ensured the first). Both are
 * the same text, so neither makes the draft differ from its base nor needs a rebase to reconcile.
 */
function textBlocks(blocks: readonly PMNode[]): readonly PMNode[] {
  const [only] = blocks;
  return blocks.length === 1 && only?.type.name === "paragraph" && only.content.size === 0
    ? []
    : blocks;
}

/** Whether the draft's text differs from its base: the persisted `has_effect` of a text branch. */
export function draftDiffersFromBase(doc: Y.Doc): boolean {
  return !blocksEqual(
    textBlocks(readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), draftSchema)),
    textBlocks(readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), draftSchema)),
  );
}
