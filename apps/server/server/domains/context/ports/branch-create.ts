/**
 * A branch placement's creates in one source (contract §6.2, §12.5): the port a branch
 * placement holds and a live placement never has. Postgres implements it over the tree
 * view; the in-memory composition has no branches and never builds a branch placement.
 */

import type { BranchId, DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts";
import type { RetractionCause } from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";
import type {
  BinaryNode,
  BranchCreateResult,
  CreateFault,
  TrackedNode,
} from "../tree/hidden-node-types.js";

/** The drafting Work's active branch, locked by the command transaction that ensured it. */
export type EnsuredBranch = { id: BranchId; workId: WorkId };

export interface BranchCreatePort {
  /** A hidden row (or, for text, another branch's, joined) and the branch's `created` row. */
  createInBranch(input: {
    branch: EnsuredBranch;
    dir: readonly string[];
    name: string;
    extension: string;
    node: TrackedNode | BinaryNode;
    /** The chat that made the create (§3.3), recorded on the change row; absent for a writer's. */
    createdBy?: { threadId: ThreadId; turnId?: TurnId };
  }): Promise<Result<BranchCreateResult, CreateFault>>;
  /** Reverse the branch's create of a document, unless another contribution makes it stand. */
  retractCreate(input: {
    branch: EnsuredBranch;
    documentId: DocumentId;
    cause: RetractionCause;
  }): Promise<"retracted" | "stands">;
}
