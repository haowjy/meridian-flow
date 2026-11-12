/**
 * What the side shows beside main. The project keeps a current chat and a current document (the
 * last of each on screen, in either pane); main shows what its address names, and the side shows
 * the current item of the other kind:
 *
 * ```text
 * main document / landing   side = current chat ?? a new chat (about main's document)
 * main chat / new chat      side = current document, else main's open tabs (the one main
 *                                  showed last, then from the right), else nothing
 * main opening              side keeps what it showed
 * ```
 *
 * A swap (the picker, a link held beside, the side composer's send) writes the current chat or
 * document, and lasts until main changes mode. Nothing derives the side from what a chat edited
 * or what a document was touched by. A document fits beside only once it is described and opens in
 * the editor: one that no longer opens (removed, an upload) falls through to the next candidate.
 * While a describe is unanswered the side keeps what it shows; it never paints a fallback and then
 * swaps.
 */
import type { OpenDocument } from "@/client/stores";
import type { Item } from "../views";

export type SettledSide = {
  /** Null: nothing to show (a chat beside which no document is open). */
  item: Item | null;
  /** A document item's descriptor. */
  document: OpenDocument | null;
};

/** What main shows, as the side's rule reads it. */
export type MainForSide =
  | { kind: "document"; documentId: string }
  | { kind: "chat"; chatId: string }
  /** The new-chat composer: main is a chat with none yet. */
  | { kind: "new-chat" }
  /** Recently opened: main names no document. */
  | { kind: "landing" }
  /** The address names a document that is still resolving. */
  | { kind: "opening" };

/** A document's descriptor as far as it is known; a null tab no longer opens in the editor. */
export type Described =
  | { status: "pending" }
  | { status: "failed"; retry: () => void }
  | { status: "ready"; document: OpenDocument | null };

/** A document to describe: a document held beside from a link keeps the link's Work. */
export type Describing = { documentId: string; workId?: string };

/** The side waits: `describing` is the document whose descriptor it waits on. */
export type SideResolution =
  | { kind: "settled"; side: SettledSide }
  | { kind: "pending"; describing: Describing | null }
  | { kind: "failed"; failed: SideFailure };

/** A document's lookup failed. */
export type SideFailure = { retry: () => void };

export function sameItem(a: Item | null, b: Item | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "document"
    ? a.documentId === (b as Extract<Item, { kind: "document" }>).documentId
    : a.chatId !== null && a.chatId === (b as Extract<Item, { kind: "chat" }>).chatId;
}

export function mainItem(main: MainForSide): Item | null {
  return main.kind === "document"
    ? { kind: "document", documentId: main.documentId }
    : main.kind === "chat"
      ? { kind: "chat", chatId: main.chatId }
      : null;
}

/** The kind of item main holds, which the side does not show; null while main is opening. */
function mainMode(main: MainForSide): Item["kind"] | null {
  if (main.kind === "opening") return null;
  return main.kind === "chat" || main.kind === "new-chat" ? "chat" : "document";
}

/** Whether an item may sit beside main, before its descriptor is known: the other kind. */
export function fitsBeside(item: Item, main: MainForSide): boolean {
  const mode = mainMode(main);
  return mode === null || item.kind !== mode;
}

export function resolveSide(input: {
  main: MainForSide;
  currentChat: string | null;
  /** Documents to try beside a chat, best first: the current document, then main's open tabs. */
  documents: readonly Describing[];
  describe: (document: Describing) => Described;
}): SideResolution {
  const { main } = input;
  if (main.kind === "opening") return { kind: "pending", describing: null };
  const settled = (item: Item | null, document: OpenDocument | null): SideResolution => ({
    kind: "settled",
    side: { item, document },
  });
  if (mainMode(main) === "document") {
    if (input.currentChat) return settled({ kind: "chat", chatId: input.currentChat }, null);
    return settled(
      main.kind === "document"
        ? { kind: "chat", chatId: null, about: main.documentId }
        : { kind: "chat", chatId: null },
      null,
    );
  }
  for (const document of input.documents) {
    const described = input.describe(document);
    if (described.status === "pending") return { kind: "pending", describing: document };
    if (described.status === "failed")
      return { kind: "failed", failed: { retry: described.retry } };
    if (described.document)
      return settled({ kind: "document", documentId: document.documentId }, described.document);
  }
  return settled(null, null);
}
