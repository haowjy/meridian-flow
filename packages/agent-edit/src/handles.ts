declare const __block: unique symbol;
declare const __doc: unique symbol;

/**
 * Opaque live block reference for resolver → apply payloads.
 *
 * This is a branded view of the model adapter's native block object, not a wrapper.
 * Object identity must be preserved for same-turn grouping and tombstone checks.
 */
export type BlockRef = { readonly [__block]: true };

/**
 * Opaque document handle for model-seam callers.
 *
 * This is a branded view of the adapter's native document object, not a wrapper.
 * Runtime identity stays with the underlying CRDT document.
 */
export type DocHandle = object & { readonly [__doc]?: true };
