/** The outcome of an inverse that kept missing its captured documents. */

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
