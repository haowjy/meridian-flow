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
import { useTreeList } from "@/client/query/useProjectTree";
import type { OpenDocument } from "@/client/stores";
import type { NewChatAbout } from "@/features/chat/CreationComposer";
import { useAccountId, useShownDocuments } from "../context/account-feature-context";
import { openDocumentFromDraftGroup } from "../context/open-document-from-draft";
import { useDescribeProjectDocument } from "../context/open-project-document";
import { recentOpening } from "../context/recent-opening";
import { useRecordOpenedDocument } from "../context/use-record-opened-document";
import { type PanePlace, useOptionalPanePlace } from "../pane-place";
import { useChatNavigation } from "../routing/chat-navigation";
import type { ReviewTarget } from "../routing/project-address";
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
  document: OpenDocument | null;
  pending: boolean;
  failed: SideFailure | null;
};

type SideView = {
  side: SideItem;
  main: MainForSide;
  chatOnScreen: string | null;
  newChatOnScreen: boolean;
  hostChatId: string | null;
  newChatAbout: NewChatAbout;
  reportNewChatAbout: (about: NewChatAbout) => void;
  revealed: number;
  place: Place;
  descriptions: Descriptions;
};

const SideViewContext = createContext<SideView | null>(null);

const describeKey = ({ documentId, workId }: Describing) => `${documentId}|${workId ?? ""}`;

type Descriptions = {
  read: (document: Describing) => Described;
  request: (documents: readonly Describing[]) => void;
};

type NodeState = "shown" | "gone" | "waiting";
const SYNCED = new Set<string>(["synced", "offline", "broken"]);

function useDescriptions(projectId: string): Descriptions {
  const describeLive = useDescribeProjectDocument(projectId);
  const accountId = useAccountId();
  const queryClient = useQueryClient();
  const describeDocument = useCallback(
    async (documentId: string, workId?: string) => {
      const pin = readDocumentView(accountId, projectId, documentId).pin;
      if (pin) {
        // slop-lint: allow swallowed-error a draft list that won't load leaves the live lookup to answer
        const drafts = await queryClient
          .fetchQuery(ownerDraftsQueryOptions(projectId, pin.draftId))
          .catch(() => null);
        const row = drafts?.items.find(
          (item) => item.itemKey === pin.itemKey && item.documentId === documentId,
        );
        if (row?.isNew) return openDocumentFromDraftGroup(row);
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
  const projectList = useTreeList({ kind: "project", projectId });
  const accountList = useTreeList({ kind: "account", userId: accountId });
  const stateOf = (documentId: string): NodeState => {
    for (const list of [projectList, accountList]) {
      const node = list.session?.replay().nodes.get(documentId);
      if (node) return node.trashed || node.purged ? "gone" : "shown";
    }
    return [projectList, accountList].every(
      (list) => list.snapshot && SYNCED.has(list.snapshot.status),
    )
      ? "gone"
      : "waiting";
  };
  const lifecycle = useRef(stateOf);
  lifecycle.current = stateOf;
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
      ([key, was]) => stateOf(key.split("|")[0] ?? "") !== was,
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
  }, [projectList.snapshot?.version, accountList.snapshot?.version]);
  const request = useCallback(
    (documents: readonly Describing[]) => {
      for (const document of documents) {
        const key = describeKey(document);
        if (asked.current.has(key)) continue;
        asked.current.add(key);
        void describeDocument(document.documentId, document.workId).then(
          (tab) => store(key, tab),
          () => store(key, "failed"),
        );
      }
    },
    [describeDocument, store],
  );
  return useMemo(
    () => ({
      read: (document) => {
        const mounted = shown.find((tab) => tab.documentId === document.documentId);
        const opens = (tab: OpenDocument | null): Described => {
          if (!tab) return { status: "ready", document: null };
          const gone = stateOf(tab.documentId) === "gone";
          return { status: "ready", document: gone ? null : tab };
        };
        if (mounted) return opens(mounted);
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
        return opens(known);
      },
      request,
    }),
    [shown, answers, request, store, projectList.snapshot?.version, accountList.snapshot?.version],
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
  }, [describingKey, descriptions.request]);

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
    [sideKey],
  );

  useRecordBesideDocument(projectId, side.item?.kind === "document" ? side.document : null);

  const mainChat = main.kind === "chat" ? main.chatId : null;
  const sideChat = side.item?.kind === "chat" ? side.item : null;
  const chatOnScreen = mainChat ?? (main.kind === "new-chat" ? null : (sideChat?.chatId ?? null));
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
        if (draft)
          setDocumentView(accountId, projectId, item.documentId, {
            pin: { draftId: draft.draftId, itemKey: draft.itemKey },
          });
        writeLastShownDocument(accountId, projectId, {
          documentId: item.documentId,
          ...(item.workId ? { workId: item.workId } : {}),
          ...(draft?.review ? { review: draft.review } : {}),
          ...(draft?.review && draft.changeId ? { changeId: draft.changeId } : {}),
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
      newChatOnScreen: showing === null,
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
      showing,
      hostChatId,
      newChatAbout,
      revealed,
      place,
      descriptions,
    ],
  );
  return <SideViewContext.Provider value={value}>{children}</SideViewContext.Provider>;
}

function useRecordBesideDocument(projectId: string, beside: OpenDocument | null) {
  const record = useRecordOpenedDocument();
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (!beside) {
      recorded.current = null;
      return;
    }
    if (recorded.current === beside.documentId) return;
    const opening = recentOpening(projectId, beside, new Date().toISOString());
    if (!opening) return;
    recorded.current = beside.documentId;
    record(opening);
  }, [beside, projectId, record]);
}

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

export function useSideItem(): SideItem {
  return useSideView().side;
}

export function useMainForSide(): MainForSide {
  return useSideView().main;
}

export function useChatOnScreen(): string | null {
  return useSideView().chatOnScreen;
}

export function useNewChatOnScreen(): boolean {
  return useSideView().newChatOnScreen;
}

export function useOptionalChatOnScreen(): string | null {
  return useContext(SideViewContext)?.chatOnScreen ?? null;
}

export function useHostChatId(): string | null {
  return useSideView().hostChatId;
}

export function useNewChatAbout(): {
  about: NewChatAbout;
  report: (about: NewChatAbout) => void;
} {
  const { newChatAbout, reportNewChatAbout } = useSideView();
  return { about: newChatAbout, report: reportNewChatAbout };
}

export type PlacedItem =
  | { kind: "document"; documentId: string; workId?: string }
  | { kind: "chat"; chatId: string | null };

export type Place = (
  item: PlacedItem,
  draft?: DraftPin & { review?: ReviewTarget; changeId?: string },
) => PanePlace;

export function usePlace(): Place {
  return useSideView().place;
}

export function useOptionalPlaceHere(): Place | null {
  const place = useContext(SideViewContext)?.place;
  const inPane = useOptionalPanePlace() !== null;
  return place ? (inPane ? place : () => "main") : null;
}

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

export function useSideRevealed(): number {
  return useSideView().revealed;
}
