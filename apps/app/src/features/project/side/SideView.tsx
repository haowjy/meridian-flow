/**
 * The side's state for one project view: what it shows (`useSideItem`), which chat is on screen,
 * and the held pick's commands (`useShellCommands`). Both shells read it: the phone's side is
 * its sheet.
 *
 * The held pick is stored per browser tab (`client/project-shell/store.ts`) and never written to
 * history: Back moves main, and the beside hint returns with its entry. Only the writer's own acts
 * release a hold: the held mark, For this, the close button, the held item becoming main, and its
 * document being closed, Discarded or removed. A fold from a narrow window is not one: the hold
 * survives it. A held chat gives way to a chat in main, and a held document that no longer opens
 * is dropped.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import type { ContextTab } from "@/client/stores";
import type { NewChatAbout } from "@/features/chat/CreationComposer";
import {
  useAccountId,
  useAccountResourceProjection,
  useOptionalPresentedDocuments,
  useShownDocuments,
} from "../context/account-feature-context";
import { useDescribeProjectDocument } from "../context/open-project-document";
import { recentOpening } from "../context/recent-opening";
import { useRecordOpenedDocument } from "../context/use-record-opened-document";
import type { Item } from "../views";
import {
  type Candidate,
  type Companion,
  type Described,
  type Describing,
  fitsBeside,
  type MainForSide,
  resolveSide,
  type SettledSide,
  type SideFailure,
  type SideReason,
  type SideSource,
} from "./side-item";

export type SideItem = {
  item: Item | null;
  /** A document item's descriptor. */
  tab: ContextTab | null;
  source: SideSource | null;
  /** Why it is there; none while the side keeps an earlier item, whose reason was about another main. */
  reason: SideReason | null;
  /** The companion read has not answered: the side keeps what it showed. */
  pending: boolean;
  /** A read the side waits on failed: the side keeps what it showed and offers a retry. */
  failed: SideFailure | null;
};

type SideView = {
  side: SideItem;
  main: MainForSide;
  /** The chat on screen, in main or beside: the draft scope under None reads it. */
  chatOnScreen: string | null;
  /** The chat host's thread: the chat on screen, else the one it last showed (kept warm, hidden). */
  hostChatId: string | null;
  /** What the side's new-chat composer is about, as its draft stands. */
  newChatAbout: NewChatAbout;
  reportNewChatAbout: (about: NewChatAbout) => void;
  /** Bumped by a hold from a link: the desktop opens the side so the hold is seen. */
  revealed: number;
  holdBeside: (pick: HeldPick) => void;
  descriptions: Descriptions;
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
  const lastDocuments: Candidate[] = [shown[0]?.documentId, recent.documents[0]?.documentId]
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ item: { kind: "document", documentId: id }, reason: "last-document" }));
  switch (main.kind) {
    case "opening":
      return { status: "pending" };
    case "landing":
      return {
        status: "ready",
        candidates: lastChatId
          ? [{ item: { kind: "chat", chatId: lastChatId }, reason: "last-chat" }]
          : [],
      };
    case "new-chat":
      return { status: "ready", candidates: lastDocuments };
    case "document": {
      if (mainIsLocal) return { status: "ready", candidates: [] };
      if (related.data) {
        // The newest chat that edited it. A chat that only read it is not "working on" it.
        const edited = related.data.chats.find((chat) => chat.edited);
        return {
          status: "ready",
          candidates: edited
            ? [{ item: { kind: "chat", chatId: edited.chatId }, reason: "edited" }]
            : [],
        };
      }
      if (related.isError) return { status: "failed", retry: () => void related.refetch() };
      return { status: "pending" };
    }
    case "chat": {
      if (chatDocuments.status === "loading") return { status: "pending" };
      if (chatDocuments.status === "error")
        return { status: "failed", retry: () => void chatDocuments.refetch() };
      // Newest first; one that no longer opens (removed, an upload) gives way to the next.
      const touched: Candidate[] = (chatDocuments.documents ?? [])
        .filter((row) => row.kind === "tracked")
        .map((row) => ({
          item: { kind: "document", documentId: row.documentId },
          reason: row.edited ? "chat-edited" : "chat-read",
        }));
      return { status: "ready", candidates: [...touched, ...lastDocuments] };
    }
  }
}

const describeKey = ({ documentId, workId }: Describing) => `${documentId}|${workId ?? ""}`;

type Descriptions = {
  /** A mounted host's descriptor, else the one resolved by identity; pending until asked for. */
  read: (document: Describing) => Described;
  /** Resolves the descriptors not yet known. */
  request: (documents: readonly Describing[]) => void;
};

/** Descriptors of documents that may sit beside, resolved once each, for the rule and the picker. */
function useDescriptions(projectId: string): Descriptions {
  const describe = useDescribeProjectDocument(projectId);
  const shown = useShownDocuments(projectId);
  const [answers, setAnswers] = useState<ReadonlyMap<string, ContextTab | null | "failed">>(
    () => new Map(),
  );
  const asked = useRef(new Set<string>());
  // "Cannot open" holds only while the document stays as it was then: a trashed document that
  // is restored opens again.
  const { records } = useAccountResourceProjection(projectId);
  const lifecycleOf = (documentId: string) =>
    records.find((record) => record.resource.identity.documentId === documentId)?.resource.lifecycle
      .kind ?? null;
  const lifecycle = useRef(lifecycleOf);
  lifecycle.current = lifecycleOf;
  const refused = useRef(new Map<string, string | null>());
  const store = useCallback((key: string, value: ContextTab | null | "failed" | undefined) => {
    if (value === null) refused.current.set(key, lifecycle.current(key.split("|")[0] ?? ""));
    else refused.current.delete(key);
    setAnswers((current) => {
      const next = new Map(current);
      if (value === undefined) next.delete(key);
      else next.set(key, value);
      return next;
    });
  }, []);
  // A mounted document's descriptor is its host's; once it unmounts (closed, removed) it is
  // described afresh rather than from an answer that may predate its removal.
  useEffect(() => {
    const mounted = new Set(shown.map((tab) => tab.documentId));
    const stale = [...asked.current].filter((key) => mounted.has(key.split("|")[0] ?? ""));
    if (stale.length === 0) return;
    for (const key of stale) {
      asked.current.delete(key);
      refused.current.delete(key);
    }
    setAnswers((current) => {
      const next = new Map(current);
      for (const key of stale) next.delete(key);
      return next;
    });
  }, [shown]);
  useEffect(() => {
    const changed = [...refused.current].filter(
      ([key, was]) => lifecycleOf(key.split("|")[0] ?? "") !== was,
    );
    if (changed.length === 0) return;
    for (const [key] of changed) {
      refused.current.delete(key);
      asked.current.delete(key);
    }
    setAnswers((current) => {
      const next = new Map(current);
      for (const [key] of changed) next.delete(key);
      return next;
    });
    // Runs when the projection changes; `lifecycleOf` reads it.
  }, [records]);
  const request = useCallback(
    (documents: readonly Describing[]) => {
      for (const document of documents) {
        const key = describeKey(document);
        if (asked.current.has(key)) continue;
        asked.current.add(key);
        void describe(document.documentId, document.workId).then(
          (tab) => store(key, tab),
          () => store(key, "failed"),
        );
      }
    },
    [describe, store],
  );
  return useMemo(
    () => ({
      read: (document) => {
        const mounted = shown.find((tab) => tab.documentId === document.documentId);
        if (mounted) return { status: "ready", tab: mounted };
        const key = describeKey(document);
        const known = answers.get(key);
        if (known === undefined) return { status: "pending" };
        if (known === "failed")
          return {
            status: "failed",
            retry: () => {
              asked.current.delete(key);
              store(key, undefined);
            },
          };
        return { status: "ready", tab: known };
      },
      request,
    }),
    [shown, answers, request, store],
  );
}

export function SideViewProvider({
  projectId,
  main,
  mainIsLocal,
  besideChatId,
  children,
}: {
  projectId: string;
  main: MainForSide;
  mainIsLocal: boolean;
  besideChatId: string | null;
  children: ReactNode;
}) {
  const accountId = useAccountId();
  const held = useHeldPick(accountId, projectId);
  const lastChatId = useLastChat(accountId, projectId);
  const companion = useCompanion(projectId, main, lastChatId, mainIsLocal);
  const descriptions = useDescriptions(projectId);
  const resolution = resolveSide({
    main,
    held,
    besideChatId,
    companion,
    describe: descriptions.read,
  });
  const describing = resolution.kind === "pending" ? resolution.describing : null;
  const describingKey = describing ? describeKey(describing) : null;
  useEffect(() => {
    if (describing) descriptions.request([describing]);
    // `describing` is read through its key.
  }, [describingKey, descriptions.request]);

  // Storing what the side last settled on, so a pending read keeps it (React's pattern for
  // information from earlier renders).
  const [kept, setKept] = useState<SettledSide | null>(null);
  if (resolution.kind === "settled" && JSON.stringify(resolution.side) !== JSON.stringify(kept))
    setKept(resolution.side);
  const settled =
    resolution.kind === "settled"
      ? resolution.side
      : kept?.item && fitsBeside(kept.item, main)
        ? reaimComposer(kept, main)
        : null;
  const sideKey = JSON.stringify([settled, resolution.kind]);
  const failed = resolution.kind === "failed" ? resolution.failed : null;
  const side = useMemo<SideItem>(
    () => ({
      item: settled?.item ?? null,
      tab: settled?.tab ?? null,
      source: settled?.source ?? null,
      reason: resolution.kind === "settled" ? (settled?.reason ?? null) : null,
      pending: resolution.kind === "pending",
      failed,
    }),
    // `failed.retry` changes identity each render; the key covers what it retries.
    [sideKey],
  );

  useReleaseHold(accountId, projectId, held, resolution.releaseHeld);
  useRecordSidePick(projectId, side.source === "held" ? side.tab : null);

  const mainChat = main.kind === "chat" ? main.chatId : null;
  const sideChat = side.item?.kind === "chat" ? side.item : null;
  const chatOnScreen = mainChat ?? (main.kind === "new-chat" ? null : (sideChat?.chatId ?? null));
  // The thread the one chat host renders. It keeps the last chat it showed while no chat is on
  // screen, so a stream and the transcript stay warm behind a picked document.
  const showing: string | null | undefined =
    mainChat ?? (main.kind === "new-chat" ? null : sideChat ? sideChat.chatId : undefined);
  const [hostChatId, setHostChatId] = useState<string | null>(showing ?? lastChatId);
  if (showing !== undefined && showing !== hostChatId) setHostChatId(showing);

  const [newChatAbout, reportNewChatAbout] = useState<NewChatAbout>("follows");
  const [revealed, setRevealed] = useState(0);
  const holdBeside = useCallback(
    (pick: HeldPick) => {
      writeHeldPick(accountId, projectId, pick);
      setRevealed((count) => count + 1);
    },
    [accountId, projectId],
  );

  const value = useMemo<SideView>(
    () => ({
      side,
      main,
      chatOnScreen,
      hostChatId,
      newChatAbout,
      reportNewChatAbout,
      revealed,
      holdBeside,
      descriptions,
    }),
    [
      side,
      JSON.stringify(main),
      chatOnScreen,
      hostChatId,
      newChatAbout,
      revealed,
      holdBeside,
      descriptions,
    ],
  );
  return <SideViewContext.Provider value={value}>{children}</SideViewContext.Provider>;
}

/** A document the writer picked beside counts as recently opened, once per pick. */
function useRecordSidePick(projectId: string, picked: ContextTab | null) {
  const record = useRecordOpenedDocument();
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (!picked) {
      recorded.current = null;
      return;
    }
    if (recorded.current === picked.documentId) return;
    const opening = recentOpening(projectId, picked, new Date().toISOString(), false);
    if (!opening) return;
    recorded.current = picked.documentId;
    record(opening);
  }, [picked, projectId, record]);
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
 * A hold ends when the side's rule says it can no longer sit beside main, and when its document
 * is closed, Discarded or removed: the registry forgets it, and the side resolves again. Nothing
 * navigates.
 */
function useReleaseHold(
  accountId: string,
  projectId: string,
  held: HeldPick | null,
  release: boolean,
) {
  const heldKey = JSON.stringify(held);
  useEffect(() => {
    if (release && JSON.stringify(readHeldPick(accountId, projectId)) === heldKey)
      writeHeldPick(accountId, projectId, null);
  }, [release, heldKey, accountId, projectId]);
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

/** What the side's new chat is about, and the composer's report of it. */
export function useNewChatAbout(): {
  about: NewChatAbout;
  report: (about: NewChatAbout) => void;
} {
  const { newChatAbout, reportNewChatAbout } = useSideView();
  return { about: newChatAbout, report: reportNewChatAbout };
}

/** Holds a document beside from a link, and has the side seen; null outside the project view. */
export function useOptionalHoldBeside(): ((pick: HeldPick) => void) | null {
  return useContext(SideViewContext)?.holdBeside ?? null;
}

/** Counts holds made from a link: the desktop opens the side on each. */
export function useSideRevealed(): number {
  return useSideView().revealed;
}

/** Whether documents open beside, as the side's rule describes them. */
export function useSideDescriptions(): Descriptions {
  return useSideView().descriptions;
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
