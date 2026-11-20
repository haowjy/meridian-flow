/**
 * A suggestion's stored attributes, on its text (`suggest_ins`, `suggest_del`), on a block it
 * added (`sug`) and on each layer of a pending attribute change (`sugAttrs`): which change, and
 * whose draft. Each changed word carries them, twice when it is replaced, and Live's history keeps
 * them for good, so they hold only what `kindOf` reads per run. Who wrote the change is stored
 * once per change beside the document (`Authors`).
 */
export type SuggestionAttrs = {
  /** One change: an insertion and the deletion it replaces share it. */
  id: string;
  /** The Work whose draft this is. */
  work: string;
};

/** Who wrote a change: a chat's turn, or the writer typing in the Work's view (no chat or turn). */
export type Author = {
  chat: string | null;
  turn: string | null;
  /** `user:<id>` or `agent`. */
  by: string;
};

/**
 * The document's change authors, by change id: a `Map`, or the Yjs map agent-edit keeps beside
 * the document's fragment (`suggestionAuthors`). `rewrite` only reads it and stages the changes
 * it starts on its transaction; whoever applies the transaction records them (`recordStarted`), so
 * an edit that never lands leaves no entry. An id with no entry reads as no one's.
 */
export type Authors = {
  get(id: string): Author | undefined;
  set(id: string, author: Author): void;
};

/** A change with who wrote it; null when the document has no author recorded for it. */
export function changeAuthor(
  change: SuggestionAttrs,
  authors: Authors,
): (SuggestionAttrs & Author) | null {
  const author = authors.get(change.id);
  return author ? { id: change.id, work: change.work, ...author } : null;
}

const ID_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A fresh change id: 12 base-36 characters (62 random bits), unique without reading the document. */
export function newChangeId(): string {
  let id = "";
  for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(12)))
    id += ID_DIGITS[byte % 36];
  return id;
}
