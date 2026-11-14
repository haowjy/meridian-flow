/** What a Work's tree shows of a document, against live: the tree half of a review item. */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";

/**
 * `created`: the document exists only in the Work. `deleting`: the Work's tree lacks a
 * document live shows (delete dominant over a move). `moving`: the Work shows the document
 * differently from live (a move, rename, reorder, or a live-deleted document the Work keeps).
 */
export type BranchTreeChange = "created" | "moving" | "deleting";

export type BranchDocumentTree = {
  documentId: DocumentId;
  origin: "created" | "edited";
  /** Created and in no view but this Work's: "new". */
  isNew: boolean;
  /** A stored object, not a text document. */
  binary: boolean;
  /** Live has it in Trash while the Work keeps it: Apply restores it first. */
  deletedLive: boolean;
  /** The Work's row on the document; null when only its text changed. */
  change: BranchTreeChange | null;
  /** What an Apply click freezes: changes with anything the Work's row says. */
  revision: string | null;
  /** The reviewable-pending predicate (`context/tree/pending-documents.ts`). */
  pending: boolean;
  /** Canonical URI in the Work's view (the last address for one the Work deleted). */
  uri: string | null;
  /** For `moving`: the URI live has it at now. */
  movedFromUri: string | null;
};

export interface BranchTreeStateReader {
  /**
   * The documents the Work has a tree row on (created, moved, deleted), plus the `edited`
   * documents the caller names (the Work's text drafts). `only` limits it to these ids.
   */
  read(
    branchId: BranchId,
    edited?: readonly DocumentId[],
    only?: readonly DocumentId[],
  ): Promise<BranchDocumentTree[]>;
}
