/** The outcome of an inverse that kept missing its captured documents. */
import type { OwnerLocks } from "../../../shared/draft-owner.js";

/**
 * An inverse whose every commit attempt missed while parts still apply: the documents kept
 * changing under it. A conflict, not a refusal: nothing was written and the writer may retry.
 */
export class ReversalConflictError extends Error {
  constructor() {
    super("the document changed while reversing; try again");
    this.name = "ReversalConflictError";
  }
}

/**
 * A card reversal's commit would lock a Work or lineage its caller did not declare, so the
 * caller's locks are in the wrong order for it. `owners` is what the commit found: the caller
 * rolls back past its claim and runs again declaring them too.
 */
export class ReversalOwnersMoved extends Error {
  constructor(readonly owners: OwnerLocks) {
    super("the reversal's Works changed while it locked them; try again");
    this.name = "ReversalOwnersMoved";
  }
}
