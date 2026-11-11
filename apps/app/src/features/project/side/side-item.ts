/**
 * What the side shows beside main (plan §4.1):
 *
 * ```text
 * side = held pick                         shown with the held mark
 *        ?? this history entry's beside    a link followed from a chat keeps that chat beside
 *        ?? companion(main), once answered
 *        ?? empty                          beside a document, a new chat about it
 *        never main's own item
 * ```
 *
 * The companion of a document is the newest chat that edited it (the `related` read); of a chat,
 * the newest document it touched that still opens, else the document the writer was on. A document
 * fits beside only once it is described and opens in the editor: one that no longer opens (removed,
 * an upload) is skipped, and a hold on one ends. While the companion read or a describe is
 * unanswered the side keeps what it shows; it never paints a fallback and then swaps. No chat sits
 * beside a chat. A hold that can no longer sit beside main ends.
 */
import type { HeldPick } from "@/client/project-shell/store";
import type { OpenDocument } from "@/client/stores";
import type { Item } from "../views";

export type SideSource = "held" | "beside" | "companion" | "empty";

export type SettledSide = {
  /** Null: nothing to show (a chat beside which no document was ever opened). */
  item: Item | null;
  /** A document item's descriptor. */
  document: OpenDocument | null;
  source: SideSource;
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

/** The companion read for main's item, as far as it has answered: its candidates, best first. */
export type Companion =
  | { status: "pending" }
  | { status: "failed"; retry: () => void }
  | { status: "ready"; candidates: readonly Item[] };

/** A document's descriptor as far as it is known; a null tab no longer opens in the editor. */
export type Described =
  | { status: "pending" }
  | { status: "failed"; retry: () => void }
  | { status: "ready"; document: OpenDocument | null };

/** A document to describe: a link's held document keeps the link's Work. */
export type Describing = { documentId: string; workId?: string };

/** The side waits: `describing` is the document whose descriptor it waits on. */
type Unsettled =
  | { kind: "pending"; describing: Describing | null }
  | { kind: "failed"; failed: SideFailure };

/** A read the side waits on failed: a document's lookup, or the companion read for main's item. */
export type SideFailure = { read: "document" | "companion"; retry: () => void };

export type SideResolution = ({ kind: "settled"; side: SettledSide } | Unsettled) & {
  /** The hold can no longer sit beside main: it ends. */
  releaseHeld: boolean;
};

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

const mainIsChat = (main: MainForSide) => main.kind === "chat" || main.kind === "new-chat";

/** The held pick as the side shows it: a new chat's composer is about main's document. */
function heldItem(held: HeldPick, main: MainForSide): Item {
  if (held.kind === "document") return { kind: "document", documentId: held.documentId };
  return held.chatId === null && main.kind === "document"
    ? { kind: "chat", chatId: null, about: main.documentId }
    : held;
}

/**
 * Whether an item may sit beside main, before its descriptor is known: never main's own, and no
 * chat beside a chat.
 */
export function fitsBeside(item: Item, main: MainForSide): boolean {
  return !sameItem(item, mainItem(main)) && (item.kind === "document" || !mainIsChat(main));
}

type Step =
  | { kind: "show"; document: OpenDocument | null }
  | { kind: "skip" }
  | { kind: "wait"; resolution: Unsettled };

export function resolveSide(input: {
  main: MainForSide;
  held: HeldPick | null;
  /** The chat this history entry was opened from. */
  besideChatId: string | null;
  companion: Companion;
  describe: (document: Describing) => Described;
}): SideResolution {
  const { main } = input;
  if (main.kind === "opening") return { kind: "pending", describing: null, releaseHeld: false };
  const step = (item: Item, workId?: string): Step => {
    if (!fitsBeside(item, main)) return { kind: "skip" };
    if (item.kind === "chat") return { kind: "show", document: null };
    const document: Describing = workId
      ? { documentId: item.documentId, workId }
      : { documentId: item.documentId };
    const described = input.describe(document);
    if (described.status === "pending")
      return { kind: "wait", resolution: { kind: "pending", describing: document } };
    if (described.status === "failed")
      return {
        kind: "wait",
        resolution: { kind: "failed", failed: { read: "document", retry: described.retry } },
      };
    return described.document ? { kind: "show", document: described.document } : { kind: "skip" };
  };
  let releaseHeld = false;
  const settle = (item: Item, tab: OpenDocument | null, source: SideSource): SideResolution => ({
    kind: "settled",
    side: { item, document: tab, source },
    releaseHeld,
  });

  if (input.held) {
    const item = heldItem(input.held, main);
    const held = step(item, input.held.kind === "document" ? input.held.workId : undefined);
    if (held.kind === "show") return settle(item, held.document, "held");
    if (held.kind === "wait") return { ...held.resolution, releaseHeld };
    releaseHeld = true;
  }
  if (input.besideChatId) {
    const item: Item = { kind: "chat", chatId: input.besideChatId };
    if (fitsBeside(item, main)) return settle(item, null, "beside");
  }
  const { companion } = input;
  if (companion.status === "pending") return { kind: "pending", describing: null, releaseHeld };
  if (companion.status === "failed")
    return { kind: "failed", failed: { read: "companion", retry: companion.retry }, releaseHeld };
  for (const candidate of companion.candidates) {
    const next = step(candidate);
    if (next.kind === "show") return settle(candidate, next.document, "companion");
    if (next.kind === "wait") return { ...next.resolution, releaseHeld };
  }
  if (main.kind === "document")
    return settle({ kind: "chat", chatId: null, about: main.documentId }, null, "empty");
  if (main.kind === "landing") return settle({ kind: "chat", chatId: null }, null, "empty");
  return {
    kind: "settled",
    side: { item: null, document: null, source: "empty" },
    releaseHeld,
  };
}
