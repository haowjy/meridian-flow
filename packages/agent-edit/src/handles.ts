import type * as Y from "yjs";

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

/** Brand a live Yjs block as an opaque BlockRef without changing object identity. */
export const toRef = (el: Y.XmlElement | BlockRef): BlockRef => el as unknown as BlockRef;

/** Recover the Yjs block inside model adapters and runtime plumbing. */
export const unwrapBlock = (ref: BlockRef): Y.XmlElement => ref as unknown as Y.XmlElement;

/** Brand a Yjs document as an opaque DocHandle without changing object identity. */
export const toDocHandle = (doc: Y.Doc): DocHandle => doc as unknown as DocHandle;

/** Recover the Yjs document inside model adapters and runtime plumbing. */
export const unwrapDoc = (handle: DocHandle): Y.Doc => handle as unknown as Y.Doc;
