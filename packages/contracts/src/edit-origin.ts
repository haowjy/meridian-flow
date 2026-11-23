import type { DraftId } from "./ids.js";

/**
 * Immutable receipt origin: the room the write merged into, Live or a draft's fork of the
 * document, and the draft the write was made in. Every Undo of a part runs in its room. A write a
 * Draft chat made in a document only its draft holds merged into that document's Live room,
 * which holds the draft's text (design §5): its origin is `live` with the draft's id.
 */
export type EditOrigin = { kind: "live"; draftId?: DraftId } | { kind: "fork"; draftId: DraftId };
