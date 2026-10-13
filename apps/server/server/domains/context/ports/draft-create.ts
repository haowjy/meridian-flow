/**
 * A draft placement's creates in one source (contract §6.2, §12.5): the port a draft
 * placement holds and a live placement never has. Postgres implements it over the tree
 * view; the in-memory composition has no drafts and never builds a draft placement.
 */
import type { DocumentId, DraftId, ThreadId, TurnId, WorkId } from "@meridian/contracts";
import type { Result } from "../../../shared/result.js";
import type {
  BinaryNode,
  CreateFault,
  DraftCreateResult,
  TrackedNode,
} from "../tree/hidden-node-types.js";

/** The drafting Work's active draft, locked by the command transaction that ensured it. */
export type EnsuredDraft = { id: DraftId; workId: WorkId };

export interface DraftCreatePort {
  /** A hidden row (or, for text, another draft's, joined) and the draft's `created` row. */
  createInDraft(input: {
    draft: EnsuredDraft;
    dir: readonly string[];
    name: string;
    extension: string;
    node: TrackedNode | BinaryNode;
    /** The chat that made the create (§3.3), recorded on the change row; absent for a writer's. */
    createdBy?: { threadId: ThreadId; turnId?: TurnId };
  }): Promise<Result<DraftCreateResult, CreateFault>>;
  /** Reverse the draft's create of a document, unless another contribution makes it stand. */
  retractCreate(input: {
    draft: EnsuredDraft;
    documentId: DocumentId;
  }): Promise<"retracted" | "stands">;
}
