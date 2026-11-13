/**
 * What the side shows beside main: the slot of the kind main is not. The project keeps one slot per
 * kind, the last chat and the last document on screen in either pane (`client/project-shell/store.ts`);
 * `useMainArrival` writes main's, a pick or link into the side writes the other.
 *
 * ```text
 * main document / landing   side = chat slot ?? a new chat (about main's document)
 * main chat / new chat / recent chats
 *                           side = document slot, else nothing (the side's empty state)
 * main opening              side keeps what it showed
 * ```
 *
 * Nothing derives the side from what a chat edited or what a document was touched by. A document
 * fits beside only once it is described and opens in the editor: one that no longer opens
 * (removed, an upload) leaves the side empty. While a describe is unanswered the side keeps what
 * it shows; it never paints a fallback and then swaps.
 *
 * Placement follows `features/project/.context/pane-state-machine.md`: change that page's rules and
 * diagrams with any change here.
 */
import type { OpenDocument } from "@/client/stores";
import type { PanePlace } from "../pane-place";
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
  /** Recent chats: the chat lane's page that names no chat. */
  | { kind: "chat-recents" }
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
export function mainMode(main: MainForSide): Item["kind"] | null {
  if (main.kind === "opening") return null;
  return main.kind === "chat" || main.kind === "new-chat" || main.kind === "chat-recents"
    ? "chat"
    : "document";
}

/** Whether an item may sit beside main, before its descriptor is known: the other kind. */
export function fitsBeside(item: Item, main: MainForSide): boolean {
  const mode = mainMode(main);
  return mode === null || item.kind !== mode;
}

/**
 * Where an item opens: main's kind in main, the other kind beside. The left sidebar always opens in
 * main, which its callers do without asking.
 */
export function placeIn(kind: Item["kind"], main: MainForSide): PanePlace {
  return kind === (mainMode(main) ?? "document") ? "main" : "side";
}

export function resolveSide(input: {
  main: MainForSide;
  chatSlot: string | null;
  documentSlot: Describing | null;
  describe: (document: Describing) => Described;
}): SideResolution {
  const { main } = input;
  if (main.kind === "opening") return { kind: "pending", describing: null };
  const settled = (item: Item | null, document: OpenDocument | null): SideResolution => ({
    kind: "settled",
    side: { item, document },
  });
  if (mainMode(main) === "document") {
    if (input.chatSlot) return settled({ kind: "chat", chatId: input.chatSlot }, null);
    return settled(
      main.kind === "document"
        ? { kind: "chat", chatId: null, about: main.documentId }
        : { kind: "chat", chatId: null },
      null,
    );
  }
  const document = input.documentSlot;
  if (!document) return settled(null, null);
  const described = input.describe(document);
  if (described.status === "pending") return { kind: "pending", describing: document };
  if (described.status === "failed") return { kind: "failed", failed: { retry: described.retry } };
  return described.document
    ? settled({ kind: "document", documentId: document.documentId }, described.document)
    : settled(null, null);
}
