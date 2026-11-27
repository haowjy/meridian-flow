import type { OpenDocument } from "@/client/stores";
import type { PanePlace } from "../pane-place";
import type { Item } from "../views";

export type SettledSide = {
  item: Item | null;
  document: OpenDocument | null;
};

export type MainForSide =
  | { kind: "document"; documentId: string }
  | { kind: "chat"; chatId: string }
  | { kind: "new-chat" }
  | { kind: "chat-recents" }
  | { kind: "landing" }
  | { kind: "opening" };

export type Described =
  | { status: "pending" }
  | { status: "failed"; retry: () => void }
  | { status: "ready"; document: OpenDocument | null };

export type Describing = { documentId: string; workId?: string };

export type SideResolution =
  | { kind: "settled"; side: SettledSide }
  | { kind: "pending"; describing: Describing | null }
  | { kind: "failed"; failed: SideFailure };

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

export function mainMode(main: MainForSide): Item["kind"] | null {
  if (main.kind === "opening") return null;
  return main.kind === "chat" || main.kind === "new-chat" || main.kind === "chat-recents"
    ? "chat"
    : "document";
}

export function fitsBeside(item: Item, main: MainForSide): boolean {
  const mode = mainMode(main);
  return mode === null || item.kind !== mode;
}

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
