/**
 * Project chat navigation over this browser's current chat (the last chat opened).
 *
 * Main shows the chat index, whose composer is where a new chat starts, or one chat the address
 * names. Beside a document the side shows the current chat, or an empty composer when there is
 * none. Every way of opening a chat navigates main to it.
 */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isThreadAwaitingCreation } from "@/client/chat-submissions";
import { threadAvailability } from "@/client/chat-submissions/thread-availability";
import { readCurrentChat, writeCurrentChat } from "@/client/current-chat";
import { useThreadSnapshotCache } from "@/client/query/thread-snapshot-query";
import { useIsThreadPendingCreation } from "@/client/stores";
import { useConversationRevealRouting } from "@/features/chat/conversation-reveal";
import type { ProjectDestination } from "./project-address";
import type { NavigationSettlement } from "./project-navigation";
import type { NavigationOptions } from "./project-route";

/**
 * The chat main shows: the index (with the current chat remembered for its reopen chip) or the
 * chat the address names. Null when main holds no chat.
 */
export type ChatDisplay =
  | { kind: "index"; currentThreadId: string | null }
  | { kind: "thread"; threadId: string };

type NewChatRequest = {
  id: number;
  workId: string | "unchanged";
};

/**
 * The thread the chat surface renders: main's chat, warm behind the index too, or beside a
 * document the current chat.
 */
export function chatSurfaceThreadId(
  navigation: Pick<ChatNavigation, "display" | "currentThreadId">,
) {
  const { display } = navigation;
  if (!display) return navigation.currentThreadId;
  return display.kind === "index" ? display.currentThreadId : display.threadId;
}

/**
 * The thread the writer is looking at: main's chat, or the side's beside a document; null on
 * the index. The draft review scope keys off this, not the surface's thread.
 */
export function displayedChatThreadId(
  navigation: Pick<ChatNavigation, "display" | "currentThreadId">,
): string | null {
  const { display } = navigation;
  if (!display) return navigation.currentThreadId;
  return display.kind === "index" ? null : display.threadId;
}

export type ChatNavigation = {
  /** The chat main shows; null when main holds no chat. */
  display: ChatDisplay | null;
  /** The last chat opened: the side shows it beside a document. */
  currentThreadId: string | null;
  /** An unacknowledged first send from before a reload needs a visible host. */
  recoveringFirstSend: boolean;
  /** Main goes to this chat: every chat door (a row, a mention, a link) is this one open. */
  openChat: (threadId: string) => Promise<void>;
  /** Main goes to the chat index, whose composer starts a new chat. */
  openNewChat: (workId?: string, options?: { replace?: boolean }) => Promise<void>;
  openChatIndex: () => Promise<void>;
  /** A just-sent new chat becomes the current chat, and main's chat if main was the index. */
  acceptCreatedChat: (threadId: string) => void;
  /** A deleted chat stops being current. */
  forgetChat: (threadId: string) => void;
  /**
   * One-shot New chat focus intent for the pinned empty composer. Non-null
   * exactly once per `openNewChat` call, until the composer that focused
   * consumes it; a composer that mounts fresh already sees it in this same
   * render, so mount timing never races a hold window.
   */
  newChatFocusRequestId: number | null;
  /** Work explicitly selected by an in-context New chat action, if any. */
  newChatWorkId: string | undefined;
  consumeNewChatFocusRequest: (id: number) => void;
};

type Go = (
  destination: ProjectDestination,
  options: NavigationOptions,
) => Promise<NavigationSettlement>;

/** Owns the current chat for one project route; returns the provider value. */
export function useProjectChatNavigation({
  accountId,
  projectId,
  mainChat,
  go,
}: {
  accountId: string;
  projectId: string;
  /** The chat the address names, or the index; null when main holds no chat. */
  mainChat: { kind: "index" } | { kind: "thread"; threadId: string } | null;
  go: Go;
}): ChatNavigation {
  const [currentThreadId, setCurrentThreadId] = useState(() =>
    readCurrentChat(accountId, projectId),
  );
  const urlChatId = mainChat?.kind === "thread" ? mainChat.threadId : null;
  const display: ChatDisplay | null = !mainChat
    ? null
    : mainChat.kind === "thread"
      ? mainChat
      : { kind: "index", currentThreadId };
  const surfaceThreadId = chatSurfaceThreadId({ display, currentThreadId });
  const [recoveringFirstSend] = useState(() =>
    isThreadAwaitingCreation(accountId, surfaceThreadId),
  );
  const [newChatRequest, setNewChatRequest] = useState<NewChatRequest | null>(null);
  const nextFocusRequestId = useRef(1);
  const mainKind = mainChat?.kind ?? null;
  const latest = useRef({ accountId, projectId, mainKind, urlChatId, currentThreadId, go });
  latest.current = { accountId, projectId, mainKind, urlChatId, currentThreadId, go };

  const { remember, commands } = useMemo(() => {
    const remember = (threadId: string | null) => {
      const { accountId, projectId } = latest.current;
      writeCurrentChat(accountId, projectId, threadId);
      setCurrentThreadId(threadId);
    };
    const go = async (destination: ProjectDestination, options: NavigationOptions) => {
      const result = await latest.current.go(destination, options);
      if (result.kind === "failed") throw result.error;
    };
    const openChat = async (threadId: string) => {
      await go({ kind: "chat", chatId: threadId }, { replace: false });
    };
    const openChatIndex = async () => {
      await go({ kind: "chat-index" }, { replace: false });
    };
    const commands = {
      openChat,
      openChatIndex,
      openNewChat: async (workId?: string, options?: { replace?: boolean }) => {
        setNewChatRequest({
          id: nextFocusRequestId.current++,
          workId: workId === undefined ? "unchanged" : workId,
        });
        if (latest.current.mainKind === "index") return;
        await go({ kind: "chat-index" }, { replace: options?.replace ?? false });
      },
      acceptCreatedChat: (threadId: string) => {
        remember(threadId);
        if (latest.current.mainKind === "index")
          void go({ kind: "chat", chatId: threadId }, { replace: false });
      },
      forgetChat: (threadId: string) => {
        if (latest.current.currentThreadId === threadId) remember(null);
      },
      consumeNewChatFocusRequest: (id: number) => {
        setNewChatRequest((current) => (current?.id === id ? null : current));
      },
    };
    return { remember, commands };
  }, []);

  useEffect(() => {
    if (urlChatId) remember(urlChatId);
  }, [urlChatId, remember]);
  useMissingChatFallback(accountId, surfaceThreadId, () => {
    remember(null);
    // Replace, never push: Back must not land on the missing chat again.
    if (latest.current.urlChatId) void go({ kind: "chat-index" }, { replace: true });
  });
  // Revealing a conversation is opening it: main goes there. One place, shared by every shell.
  useConversationRevealRouting(commands.openChat);

  const newChatFocusRequestId = newChatRequest?.id ?? null;
  const newChatWorkId = newChatRequest?.workId === "unchanged" ? undefined : newChatRequest?.workId;
  const displayKey = JSON.stringify(display);
  const stableDisplay = useMemo(() => display, [displayKey]);

  return useMemo(
    () => ({
      ...commands,
      display: stableDisplay,
      currentThreadId,
      recoveringFirstSend,
      newChatFocusRequestId,
      newChatWorkId,
    }),
    [
      commands,
      stableDisplay,
      currentThreadId,
      recoveringFirstSend,
      newChatFocusRequestId,
      newChatWorkId,
    ],
  );
}

/**
 * A chat the server no longer has (deleted elsewhere, or a stale link) is let
 * go. A 404 recorded before the chat was last pending creation is the benign
 * race of a first send, not a missing chat, even once the send is acknowledged.
 */
function useMissingChatFallback(accountId: string, threadId: string | null, onMissing: () => void) {
  const pending = useIsThreadPendingCreation(threadId);
  const { error, errorUpdatedAt } = useThreadSnapshotCache(threadId) ?? {
    error: null,
    errorUpdatedAt: 0,
  };
  const availability = threadAvailability(error, accountId);
  const notFound =
    !!error &&
    "status" in error &&
    error.status === 404 &&
    availability !== "deleted" &&
    availability !== "project-deleted";
  const pendingAt = useRef(0);
  const latest = useRef(onMissing);
  latest.current = onMissing;
  useEffect(() => {
    if (!threadId) return;
    if (pending) {
      pendingAt.current = Date.now();
      return;
    }
    if (notFound && errorUpdatedAt > pendingAt.current) latest.current();
  }, [threadId, pending, notFound, errorUpdatedAt]);
}

const ChatNavigationContext = createContext<ChatNavigation | null>(null);

export function ChatNavigationProvider({
  value,
  children,
}: {
  value: ChatNavigation;
  children: ReactNode;
}) {
  return <ChatNavigationContext.Provider value={value}>{children}</ChatNavigationContext.Provider>;
}

/** Chat commands are pane-aware at the route boundary; consumers never write a URL. */
export function useChatNavigation(): ChatNavigation {
  const navigation = useContext(ChatNavigationContext);
  if (!navigation) throw new Error("Chat navigation requires a project route");
  return navigation;
}
