/**
 * The side's state for one project view: what it shows (`useSideItem`), which chat is on screen,
 * and the placement command. Both shells read it: the phone's side is its sheet.
 *
 * The side shows the slot of the kind main is not (`resolveSide`, `side-item.ts`). A pick or a link
 * into the side writes its kind's slot, stored per browser tab (`client/project-shell/store.ts`),
 * never in history; main's arrival writes the other (`useMainArrival`).
 */

import { useQueryClient } from "@tanstack/react-query";
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
  type DraftPin,
  readDocumentView,
  setDocumentView,
} from "@/client/project-shell/document-views";
import {
  useLastShownChat,
  useLastShownDocument,
  writeLastShownChat,
  writeLastShownDocument,
} from "@/client/project-shell/store";
import { ownerDraftsQueryOptions } from "@/client/query/useOwnerDrafts";
import type { OpenDocument } from "@/client/stores";
import type { NewChatAbout } from "@/features/chat/CreationComposer";
import {
  useAccountId,
  useAccountResourceProjection,
  useShownDocuments,
} from "../context/account-feature-context";
import { openDocumentFromDraftGroup } from "../context/open-document-from-draft";
import { projectResourceDocument } from "../context/open-document-from-file";
import { useDescribeProjectDocument } from "../context/open-project-document";
import { recentOpening } from "../context/recent-opening";
import { useIsDraftOnly } from "../context/use-is-draft-only";
import { useRecordOpenedDocument } from "../context/use-record-opened-document";
import { type PanePlace, useOptionalPanePlace } from "../pane-place";
import { useChatNavigation } from "../routing/chat-navigation";
import type { Item } from "../views";
import {
  type Described,
  type Describing,
  fitsBeside,
  type MainForSide,
  placeIn,
  resolveSide,
  type SettledSide,
  type SideFailure,
} from "./side-item";

export type SideItem = {
  item: Item | null;
  /** A document item's descriptor. */
  document: OpenDocument | null;
  /** A document's descriptor has not answered: the side keeps what it showed. */
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
  /** Bumped by an item placed in the side: the desktop opens the side, the phone its sheet, so it is seen. */
  revealed: number;
  place: Place;
  descriptions: Descriptions;
};

const SideViewContext = createContext<SideView | null>(null);

const describeKey = ({ documentId, workId }: Describing) => `${documentId}|${workId ?? ""}`;

type Descriptions = {
  /** A mounted host's descriptor, else the one resolved by identity; pending until asked for. */
  read: (document: Describing) => Described;
  /** Resolves the descriptors not yet known. */
  request: (documents: readonly Describing[]) => void;
};

/** Descriptors of documents that may sit beside, resolved once each, for the rule and the picker. */
function useDescriptions(projectId: string): Descriptions {
  const describeLive = useDescribeProjectDocument(projectId);
  const accountId = useAccountId();
  const queryClient = useQueryClient();
  // A page only a draft holds has no live entry: the draft its view shows describes it, as it
  // does for main's address.
  const describe = useCallback(
    async (documentId: string, workId?: string) => {
      const pin = readDocumentView(accountId, projectId, documentId).pin;
      if (pin) {
        // slop-lint: allow swallowed-error a draft list that won't load leaves the live lookup to answer
        const drafts = await queryClient
          .fetchQuery(ownerDraftsQueryOptions(projectId, pin.ownerKey))
          .catch(() => null);
        const row = drafts?.items.find(
          (item) => item.itemKey === pin.itemKey && item.documentId === documentId,
        );
        if (row && (row.isNew || row.deletedLive)) return openDocumentFromDraftGroup(row);
      }
      return describeLive(documentId, workId);
    },
    [describeLive, accountId, projectId, queryClient],
  );
  const shown = useShownDocuments(projectId);
  const [answers, setAnswers] = useState<ReadonlyMap<string, OpenDocument | null | "failed">>(
    () => new Map(),
  );
  const asked = useRef(new Set<string>());
  // "Cannot open" holds only while the document stays as it was then: a trashed document that
  // is restored opens again.
  const { records, placement } = useAccountResourceProjection(projectId);
  const isDraftOnly = useIsDraftOnly(projectId);
  const lifecycleOf = (documentId: string) =>
    records.find((record) => record.resource.identity.documentId === documentId)?.resource.lifecycle
      .kind ?? null;
  const lifecycle = useRef(lifecycleOf);
  lifecycle.current = lifecycleOf;
  const refused = useRef(new Map<string, string | null>());
  const store = useCallback((key: string, value: OpenDocument | null | "failed" | undefined) => {
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
        if (mounted) {
          // A document deleted or removed while it sits here no longer opens: the side is empty.
          const { kind } = projectResourceDocument(
            mounted,
            records,
            placement,
            isDraftOnly(mounted.documentId),
          );
          return {
            status: "ready",
            document: kind === "terminal" || kind === "removed" ? null : mounted,
          };
        }
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
        return { status: "ready", document: known };
      },
      request,
    }),
    [shown, answers, request, store, records, placement, isDraftOnly],
  );
}

export function SideViewProvider({
  projectId,
  main,
  children,
}: {
  projectId: string;
  main: MainForSide;
  children: ReactNode;
}) {
  const accountId = useAccountId();
  const lastShownChatId = useLastShownChat(accountId, projectId);
  const documentSlot = useLastShownDocument(accountId, projectId);
  const descriptions = useDescriptions(projectId);
  const resolution = resolveSide({
    main,
    chatSlot: lastShownChatId,
    documentSlot,
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
      document: settled?.document ?? null,
      pending: resolution.kind === "pending",
      failed,
    }),
    // `failed.retry` changes identity each render; the key covers what it retries.
    [sideKey],
  );

  useRecordBesideDocument(projectId, side.item?.kind === "document" ? side.document : null);

  const mainChat = main.kind === "chat" ? main.chatId : null;
  const sideChat = side.item?.kind === "chat" ? side.item : null;
  const chatOnScreen = mainChat ?? (main.kind === "new-chat" ? null : (sideChat?.chatId ?? null));
  // The thread the one chat host renders. It keeps the last chat it showed while no chat is on
  // screen, so a stream and the transcript stay warm behind the document the side shows.
  const showing: string | null | undefined =
    mainChat ?? (main.kind === "new-chat" ? null : sideChat ? sideChat.chatId : undefined);
  const [hostChatId, setHostChatId] = useState<string | null>(showing ?? lastShownChatId);
  if (showing !== undefined && showing !== hostChatId) setHostChatId(showing);

  const [newChatAbout, reportNewChatAbout] = useState<NewChatAbout>("follows");
  const [revealed, setRevealed] = useState(0);
  const mainRef = useRef(main);
  mainRef.current = main;
  const place = useCallback<Place>(
    (item, draft) => {
      const pane = placeIn(item.kind, mainRef.current);
      if (pane === "main") return pane;
      if (item.kind === "document") {
        if (draft) setDocumentView(accountId, projectId, item.documentId, { pin: draft });
        writeLastShownDocument(accountId, projectId, {
          documentId: item.documentId,
          ...(item.workId ? { workId: item.workId } : {}),
        });
      } else writeLastShownChat(accountId, projectId, item.chatId);
      setRevealed((count) => count + 1);
      return pane;
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
      place,
      descriptions,
    }),
    [
      side,
      JSON.stringify(main),
      chatOnScreen,
      hostChatId,
      newChatAbout,
      revealed,
      place,
      descriptions,
    ],
  );
  return <SideViewContext.Provider value={value}>{children}</SideViewContext.Provider>;
}

/** A document shown beside counts as recently opened, once. */
function useRecordBesideDocument(projectId: string, beside: OpenDocument | null) {
  const record = useRecordOpenedDocument();
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (!beside) {
      recorded.current = null;
      return;
    }
    if (recorded.current === beside.documentId) return;
    const opening = recentOpening(projectId, beside, new Date().toISOString(), false);
    if (!opening) return;
    recorded.current = beside.documentId;
    record(opening);
  }, [beside, projectId, record]);
}

/** A kept new-chat composer is about main's document, not the one it was settled beside. */
function reaimComposer(kept: SettledSide, main: MainForSide): SettledSide {
  const item = kept.item;
  if (item?.kind !== "chat" || item.chatId !== null || !item.about) return kept;
  return main.kind === "document" && item.about !== main.documentId
    ? { ...kept, item: { ...item, about: main.documentId } }
    : kept;
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

/** What `place` opens: a link's target, with the Work a document link names; a null chat is the side's new chat. */
export type PlacedItem =
  | { kind: "document"; documentId: string; workId?: string }
  | { kind: "chat"; chatId: string | null };

/**
 * The one placement command: where `item` opens (`placeIn`). It returns the pane. For the side it
 * has already written the slot (and the draft the document shows) and had the side seen; for main
 * the caller opens the item, since only it knows how (a live page, a draft, a chat).
 */
export type Place = (
  item: PlacedItem,
  /** With a document, the draft it shows. */
  draft?: DraftPin,
) => PanePlace;

/** The placement command; the side's picker and empty list choose through it too. */
export function usePlace(): Place {
  return useSideView().place;
}

/**
 * `place` for a surface that follows links: outside a pane (the left sidebar) there is nothing to
 * place beside, so an open goes to main. Null outside the project view.
 */
export function useOptionalPlaceHere(): Place | null {
  const place = useContext(SideViewContext)?.place;
  const inPane = useOptionalPanePlace() !== null;
  return place ? (inPane ? place : () => "main") : null;
}

/**
 * Opens a chat from a pane (a link, a door, a reveal): in the side or in main. The one entrance for
 * `ChatThreadNavigation` and the conversation reveal. `from` is null outside a pane (the sidebar).
 */
export function usePlaceChat(): (threadId: string, from: PanePlace | undefined) => void {
  const place = useSideView().place;
  const { openChat } = useChatNavigation();
  return useCallback(
    (threadId, from) => {
      if (from && place({ kind: "chat", chatId: threadId }) === "side") return;
      void openChat(threadId);
    },
    [place, openChat],
  );
}

/** Counts items placed in the side: the desktop opens the side on each. */
export function useSideRevealed(): number {
  return useSideView().revealed;
}

/** Whether documents open beside, as the side's rule describes them. */
export function useSideDescriptions(): Descriptions {
  return useSideView().descriptions;
}
