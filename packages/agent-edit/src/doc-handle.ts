declare const __doc: unique symbol;

/**
 * Opaque document handle for model-seam callers.
 *
 * This is a branded view of the adapter's native document object, not a wrapper.
 * Runtime identity stays with the underlying CRDT document.
 */
export type DocHandle = object & { readonly [__doc]?: true };
