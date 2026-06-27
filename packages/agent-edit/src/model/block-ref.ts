import type * as Y from "yjs";
import type { BlockRef } from "../block-ref.js";

/** Brand a live Yjs block as an opaque BlockRef without changing object identity. */
export const toRef = (el: Y.XmlElement | BlockRef): BlockRef => el as unknown as BlockRef;

/** Recover the Yjs block for model adapter calls while Phase 1 still uses Yjs verbs. */
export const unwrapBlock = (ref: BlockRef): Y.XmlElement => ref as unknown as Y.XmlElement;
