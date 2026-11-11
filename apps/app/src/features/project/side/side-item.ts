/**
 * What the side shows beside main (plan §4.1):
 *
 * ```text
 * side = held pick                         shown with the held mark
 *        ?? this history entry's beside    a link followed from a chat keeps that chat beside
 *        ?? companion(main), once answered shown with its reason
 *        ?? empty                          beside a document, a new chat about it
 *        never main's own item
 * ```
 *
 * The companion of a document is the newest chat that edited it (the `related` read); of a chat,
 * the newest document it touched, else the document the writer was on. While the companion read
 * is unanswered the side keeps what it shows; it never paints a fallback and then swaps. No chat
 * sits beside a chat. The phone's side is its chat sheet, which holds chats only.
 */
import type { HeldPick } from "@/client/project-shell/store";
import type { Item } from "../views";

/** Why the side shows its item: the header and the picker say so. */
export type SideReason =
  | "held"
  | "opened-from"
  | "edited"
  | "chat-edited"
  | "chat-read"
  | "last-document"
  | "last-chat"
  | "new-chat";

export type SideSource = "held" | "beside" | "companion" | "empty";

export type SettledSide = {
  /** Null: nothing to show (a chat beside which no document was ever opened). */
  item: Item | null;
  source: SideSource;
  reason: SideReason | null;
};

/** What main shows, as the side's rule reads it. */
export type MainForSide =
  | { kind: "document"; documentId: string }
  | { kind: "chat"; chatId: string }
  /** The new-chat composer: main is a chat with none yet. */
  | { kind: "chat-index" }
  /** Recently opened: main names no document. */
  | { kind: "landing" }
  /** The address names a document that is still resolving. */
  | { kind: "opening" };

/** The companion read for main's item, as far as it has answered. */
export type Companion =
  | { status: "pending" }
  | { status: "failed"; retry: () => void }
  | { status: "ready"; item: Item | null; reason: SideReason | null };

export type SideResolution =
  | { kind: "settled"; side: SettledSide }
  | { kind: "pending" }
  | { kind: "failed"; retry: () => void };

export function sameItem(a: Item | null, b: Item | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "document"
    ? a.documentId === (b as Extract<Item, { kind: "document" }>).documentId
    : a.chatId !== null && a.chatId === (b as Extract<Item, { kind: "chat" }>).chatId;
}

function mainItem(main: MainForSide): Item | null {
  return main.kind === "document"
    ? { kind: "document", documentId: main.documentId }
    : main.kind === "chat"
      ? { kind: "chat", chatId: main.chatId }
      : null;
}

const mainIsChat = (main: MainForSide) => main.kind === "chat" || main.kind === "chat-index";

/** The held pick as the side shows it: a new chat's composer is about main's document. */
function heldItem(held: HeldPick, main: MainForSide): Item {
  if (held.kind === "document") return held;
  return held.chatId === null && main.kind === "document"
    ? { kind: "chat", chatId: null, about: main.documentId }
    : held;
}

/** Whether an item may sit beside main: never main's own, no chat beside a chat, chats only on the phone. */
export function fitsBeside(item: Item, main: MainForSide, chatsOnly: boolean): boolean {
  return (
    !sameItem(item, mainItem(main)) && (item.kind === "document" ? !chatsOnly : !mainIsChat(main))
  );
}

export function resolveSide(input: {
  main: MainForSide;
  held: HeldPick | null;
  /** The chat this history entry was opened from. */
  besideChatId: string | null;
  companion: Companion;
  /** The phone's sheet holds chats only, and only beside a document or Recently opened. */
  chatsOnly: boolean;
}): SideResolution {
  const { main } = input;
  // Nothing beside a chat but documents, so a held chat or a beside hint waits out a chat in main.
  const fits = (item: Item) => fitsBeside(item, main, input.chatsOnly);
  if (main.kind === "opening") return { kind: "pending" };
  if (input.held) {
    const item = heldItem(input.held, main);
    if (fits(item)) return { kind: "settled", side: { item, source: "held", reason: "held" } };
  }
  if (input.besideChatId) {
    const item: Item = { kind: "chat", chatId: input.besideChatId };
    if (fits(item))
      return { kind: "settled", side: { item, source: "beside", reason: "opened-from" } };
  }
  const { companion } = input;
  if (companion.status === "pending") return { kind: "pending" };
  if (companion.status === "failed") return { kind: "failed", retry: companion.retry };
  if (companion.item && fits(companion.item))
    return {
      kind: "settled",
      side: { item: companion.item, source: "companion", reason: companion.reason },
    };
  if (main.kind === "document")
    return {
      kind: "settled",
      side: {
        item: { kind: "chat", chatId: null, about: main.documentId },
        source: "empty",
        reason: "new-chat",
      },
    };
  if (main.kind === "landing")
    return {
      kind: "settled",
      side: { item: { kind: "chat", chatId: null }, source: "empty", reason: "new-chat" },
    };
  return { kind: "settled", side: { item: null, source: "empty", reason: null } };
}
