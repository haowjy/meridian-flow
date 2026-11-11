/**
 * The side's state for one project view: what it shows (`useSideItem`), which chat is on screen,
 * and the held pick's commands (`useShellCommands`). Both shells read it; the phone's sheet holds
 * chats only.
 *
 * The held pick is stored per browser tab (`client/project-shell/store.ts`) and never written to
 * history: Back moves main, and the beside hint returns with its entry. A hold ends by the held
 * mark, by "Follow" in the picker, by closing the side, when its item becomes main, and when its
 * document is closed, Discarded or removed.
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import {
  type HeldPick,
  readHeldPick,
  useHeldPick,
  useLastChat,
  writeHeldPick,
} from "@/client/project-shell/store";
import { useDocumentRelated } from "@/client/query/useDocumentRelated";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
import { useThreadRecentDocuments } from "@/client/query/useThreadRecentDocuments";
import {
  useAccountId,
  useOptionalPresentedDocuments,
  useShownDocuments,
} from "../context/account-feature-context";
import type { Item } from "../views";
import {
  type Companion,
  fitsBeside,
  type MainForSide,
  resolveSide,
  type SettledSide,
  type SideReason,
  type SideSource,
  sameItem,
} from "./side-item";

export type SideItem = {
  item: Item | null;
  source: SideSource | null;
  reason: SideReason | null;
  /** The companion read has not answered: the side keeps what it showed. */
  pending: boolean;
  /** The companion read failed: the side keeps what it showed and offers this retry. */
  retry: (() => void) | null;
};

type SideView = {
  side: SideItem;
  main: MainForSide;
  /** The chat on screen, in main or beside: the draft scope under None reads it. */
  chatOnScreen: string | null;
  /** The chat host's thread: the chat on screen, else the one it last showed (kept warm, hidden). */
  hostChatId: string | null;
};

const SideViewContext = createContext<SideView | null>(null);

function useCompanion(
  projectId: string,
  main: MainForSide,
  lastChatId: string | null,
  /** Main's document lives only on this device: the server has no chats for it. */
  mainIsLocal: boolean,
): Companion {
  const documentId = main.kind === "document" && !mainIsLocal ? main.documentId : null;
  const related = useDocumentRelated(projectId, documentId);
  const chatId = main.kind === "chat" ? main.chatId : null;
  const chatDocuments = useThreadRecentDocuments(chatId);
  const shown = useShownDocuments(projectId);
  const recent = useRecentDocuments(projectId);
  // The document the writer was on: the last one on screen (a draft-only one included, which
  // recents never list), else the account's most recent.
  const lastDocumentId = shown[0]?.documentId ?? recent.documents[0]?.documentId ?? null;
  const lastDocument = (): Companion => ({
    status: "ready",
    item: lastDocumentId ? { kind: "document", documentId: lastDocumentId } : null,
    reason: lastDocumentId ? "last-document" : null,
  });
  switch (main.kind) {
    case "opening":
      return { status: "pending" };
    case "landing":
      return {
        status: "ready",
        item: lastChatId ? { kind: "chat", chatId: lastChatId } : null,
        reason: lastChatId ? "last-chat" : null,
      };
    case "chat-index":
      return lastDocument();
    case "document": {
      if (mainIsLocal) return { status: "ready", item: null, reason: null };
      if (related.data) {
        // The newest chat that edited it. A chat that only read it is not "working on" it.
        const edited = related.data.chats.find((chat) => chat.edited);
        return edited
          ? { status: "ready", item: { kind: "chat", chatId: edited.chatId }, reason: "edited" }
          : { status: "ready", item: null, reason: null };
      }
      if (related.isError) return { status: "failed", retry: () => void related.refetch() };
      return { status: "pending" };
    }
    case "chat": {
      if (chatDocuments.status === "loading") return { status: "pending" };
      if (chatDocuments.status === "error")
        return { status: "failed", retry: () => void chatDocuments.refetch() };
      const first = chatDocuments.documents?.find((row) => row.kind === "tracked");
      return first
        ? {
            status: "ready",
            item: { kind: "document", documentId: first.documentId },
            reason: first.edited ? "chat-edited" : "chat-read",
          }
        : lastDocument();
    }
  }
}

export function SideViewProvider({
  projectId,
  main,
  mainIsLocal,
  besideChatId,
  chatsOnly,
  children,
}: {
  projectId: string;
  main: MainForSide;
  mainIsLocal: boolean;
  besideChatId: string | null;
  chatsOnly: boolean;
  children: ReactNode;
}) {
  const accountId = useAccountId();
  const held = useHeldPick(accountId, projectId);
  const lastChatId = useLastChat(accountId, projectId);
  const companion = useCompanion(projectId, main, lastChatId, mainIsLocal);
  const resolution = resolveSide({ main, held, besideChatId, companion, chatsOnly });

  // Storing what the side last settled on, so a pending read keeps it (React's pattern for
  // information from earlier renders).
  const [kept, setKept] = useState<SettledSide | null>(null);
  if (resolution.kind === "settled" && JSON.stringify(resolution.side) !== JSON.stringify(kept))
    setKept(resolution.side);
  const settled =
    resolution.kind === "settled"
      ? resolution.side
      : kept?.item && fitsBeside(kept.item, main, chatsOnly)
        ? reaimComposer(kept, main)
        : null;
  const sideKey = JSON.stringify([settled, resolution.kind]);
  const retry = resolution.kind === "failed" ? resolution.retry : null;
  const side = useMemo<SideItem>(
    () => ({
      item: settled?.item ?? null,
      source: settled?.source ?? null,
      reason: settled?.reason ?? null,
      pending: resolution.kind === "pending",
      retry,
    }),
    // `retry` changes identity each render; the key covers what it retries.
    [sideKey],
  );

  useReleaseHold(accountId, projectId, held, main);

  const mainChat = main.kind === "chat" ? main.chatId : null;
  const sideChat = side.item?.kind === "chat" ? side.item : null;
  const chatOnScreen = mainChat ?? (main.kind === "chat-index" ? null : (sideChat?.chatId ?? null));
  // The thread the one chat host renders. It keeps the last chat it showed while no chat is on
  // screen, so a stream and the transcript stay warm behind a picked document.
  const showing: string | null | undefined =
    mainChat ?? (main.kind === "chat-index" ? lastChatId : sideChat ? sideChat.chatId : undefined);
  const [hostChatId, setHostChatId] = useState<string | null>(showing ?? lastChatId);
  if (showing !== undefined && showing !== hostChatId) setHostChatId(showing);

  const value = useMemo<SideView>(
    () => ({ side, main, chatOnScreen, hostChatId }),
    [side, JSON.stringify(main), chatOnScreen, hostChatId],
  );
  return <SideViewContext.Provider value={value}>{children}</SideViewContext.Provider>;
}

/** A kept new-chat composer is about main's document, not the one it was settled beside. */
function reaimComposer(kept: SettledSide, main: MainForSide): SettledSide {
  const item = kept.item;
  if (item?.kind !== "chat" || item.chatId !== null || !item.about) return kept;
  return main.kind === "document" && item.about !== main.documentId
    ? { ...kept, item: { ...item, about: main.documentId } }
    : kept;
}

/**
 * A hold ends when its item becomes main (rule 3), and when its document is closed, Discarded or
 * removed: the registry forgets it, and the side resolves again. Nothing navigates.
 */
function useReleaseHold(
  accountId: string,
  projectId: string,
  held: HeldPick | null,
  main: MainForSide,
) {
  const heldOnMain =
    held !== null &&
    sameItem(
      held,
      main.kind === "document"
        ? { kind: "document", documentId: main.documentId }
        : main.kind === "chat"
          ? { kind: "chat", chatId: main.chatId }
          : null,
    );
  useEffect(() => {
    if (heldOnMain) writeHeldPick(accountId, projectId, null);
  }, [heldOnMain, accountId, projectId]);
  const presented = useOptionalPresentedDocuments();
  const heldDocumentId = held?.kind === "document" ? held.documentId : null;
  useEffect(() => {
    if (!presented || !heldDocumentId) return;
    const check = () => {
      const mounted = presented
        .documents(projectId)
        .some((tab) => tab.documentId === heldDocumentId);
      const forgotten =
        mounted && !presented.shown(projectId).some((tab) => tab.documentId === heldDocumentId);
      const current = readHeldPick(accountId, projectId);
      if (forgotten && current?.kind === "document" && current.documentId === heldDocumentId)
        writeHeldPick(accountId, projectId, null);
    };
    check();
    return presented.subscribe(check);
  }, [presented, heldDocumentId, accountId, projectId]);
}

function useSideView(): SideView {
  const view = useContext(SideViewContext);
  if (!view) throw new Error("The side's state requires the project view");
  return view;
}

/** What the side shows beside main, and why. */
export function useSideItem(): SideItem {
  return useSideView().side;
}

/** Main as the side's rule reads it. */
export function useMainForSide(): MainForSide {
  return useSideView().main;
}

/** The chat on screen, in main or beside; null on the new-chat composer. */
export function useChatOnScreen(): string | null {
  return useSideView().chatOnScreen;
}

/** Outside the project view (a document menu mounted elsewhere), there is no chat on screen. */
export function useOptionalChatOnScreen(): string | null {
  return useContext(SideViewContext)?.chatOnScreen ?? null;
}

/** The thread the one chat host renders. */
export function useHostChatId(): string | null {
  return useSideView().hostChatId;
}

/** The shell's commands for the side. Neither writes main or history. */
export function useShellCommands(projectId: string): {
  /** Sets the held pick: the side shows it until released. */
  pickSide(item: HeldPick): void;
  /** Back to following main. */
  releaseSide(): void;
} {
  const accountId = useAccountId();
  return useMemo(
    () => ({
      pickSide: (item) => writeHeldPick(accountId, projectId, item),
      releaseSide: () => writeHeldPick(accountId, projectId, null),
    }),
    [accountId, projectId],
  );
}
