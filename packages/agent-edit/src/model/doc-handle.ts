import type * as Y from "yjs";
import type { DocHandle } from "../doc-handle.js";

/** Brand a Yjs document as an opaque DocHandle without changing object identity. */
export const toDocHandle = (doc: Y.Doc): DocHandle => doc as unknown as DocHandle;

/** Recover the Yjs document inside model adapters and runtime plumbing. */
export const unwrapDoc = (handle: DocHandle): Y.Doc => handle as unknown as Y.Doc;
