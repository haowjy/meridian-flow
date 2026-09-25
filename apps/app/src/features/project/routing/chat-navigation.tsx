/**
 * Project chat navigation over this browser's current chat.
 *
 * The Chat screen's center shows the chat index, whose composer is where a new
 * chat starts, or one chat addressed by URL. Everywhere else the dock shows the
 * current chat, or an empty composer when there is none. Opening a chat on the
 * Chat screen navigates. Anywhere else it reveals the dock and the screen stays.
 */
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readFirstSendSubmission } from "@/client/chat-submissions";
import { readCurrentChat, writeCurrentChat } from "@/client/current-chat";
import { threadSnapshotQueryOptions } from "@/client/query/useThreadSnapshotSync";
import { useIsThreadPendingCreation } from "@/client/stores";
import { useConversationRevealRouting } from "@/features/chat/conversation-reveal";
import type { ScreenKey } from "../shell/screens";
import type { ProjectDestination } from "./project-address";
import type { NavigationOptions } from "./project-route";

/**
 * What the writer's screen currently shows for chat: the index (with the
 * current chat remembered for its reopen chip), a specific chat the URL
 * addresses, or the dock's chat (or none). Exactly one variant is ever true;
 * consumers switch on `kind` instead of ANDing a thread id with an index flag.
 */
export type ChatDisplay =
  | { kind: "index"; currentThreadId: string | null }
  | { kind: "thread"; threadId: string }
  | { kind: "dock"; threadId: string | null };

/** The thread the persistent chat surface renders, warm behind the index too. */
export function chatSurfaceThreadId(display: ChatDisplay): string | null {
  return display.kind === "index" ? display.currentThreadId : display.threadId;
}

/**
 * The thread the writer is looking at as primary content: null on the index.
 * The rail and the draft review scope key off this, not the surface's thread.
 */
export function displayedChatThreadId(display: ChatDisplay): string | null {
  return display.kind === "index" ? null : display.threadId;
}

export type ChatNavigation = {
  /** What the Chat screen or the dock currently shows. */
  display: ChatDisplay;
  /** An unacknowledged first send from before a reload needs a visible host. */
  recoveringFirstSend: boolean;
  openChat: (threadId: string) => Promise<void>;
  /** The Chat screen: the current chat, or the index when there is none. */
  showChatScreen: () => Promise<void>;
  /** The Chat screen's index; in the dock, an empty composer. */
  openNewChat: () => Promise<void>;
  openChatIndex: () => Promise<void>;
  /** A just-sent new chat becomes the chat on screen. */
  acceptCreatedChat: (threadId: string) => void;
  /** A deleted chat stops being current. */
  forgetChat: (threadId: string) => void;
  /** The shell's way to show the dock's chat. The latest registration wins. */
  registerDockReveal: (reveal: () => void) => () => void;
  /**
   * One-shot New chat focus intent for the pinned empty composer. Non-null
   * exactly once per `openNewChat` call, until the composer that focused
   * consumes it; a composer that mounts fresh already sees it in this same
   * render, so mount timing never races a hold window.
   */
  newChatFocusRequestId: number | null;
  consumeNewChatFocusRequest: (id: number) => void;
};

type Go = (destination: ProjectDestination, options: NavigationOptions) => Promise<unknown>;

function computeChatDisplay(
  activeScreen: ScreenKey,
  urlChatId: string | null,
  currentThreadId: string | null,
): ChatDisplay {
  if (activeScreen !== "chat") return { kind: "dock", threadId: currentThreadId };
  if (urlChatId !== null) return { kind: "thread", threadId: urlChatId };
  return { kind: "index", currentThreadId };
}

/** Owns the current chat for one project route; returns the provider value. */
export function useProjectChatNavigation({
  accountId,
  projectId,
  activeScreen,
  urlChatId,
  go,
}: {
  accountId: string;
  projectId: string;
  activeScreen: ScreenKey;
  urlChatId: string | null;
  go: Go;
}): ChatNavigation {
  const [currentThreadId, setCurrentThreadId] = useState(() =>
    readCurrentChat(accountId, projectId),
  );
  const display = computeChatDisplay(activeScreen, urlChatId, currentThreadId);
  const surfaceThreadId = chatSurfaceThreadId(display);
  const [recoveringFirstSend] = useState(
    () => surfaceThreadId !== null && readFirstSendSubmission(accountId, surfaceThreadId) !== null,
  );
  const [channels] = useState(createChannels);
  const [newChatFocusRequestId, setNewChatFocusRequestId] = useState<number | null>(null);
  const nextFocusRequestId = useRef(1);
  const latest = useRef({ accountId, projectId, activeScreen, urlChatId, currentThreadId, go });
  latest.current = { accountId, projectId, activeScreen, urlChatId, currentThreadId, go };

  const { remember, commands } = useMemo(() => {
    const remember = (threadId: string | null) => {
      const { accountId, projectId } = latest.current;
      writeCurrentChat(accountId, projectId, threadId);
      setCurrentThreadId(threadId);
    };
    const onChatScreen = () => latest.current.activeScreen === "chat";
    const openChat = async (threadId: string) => {
      if (onChatScreen()) {
        await latest.current.go({ kind: "chat", chatId: threadId }, { replace: false });
        return;
      }
      remember(threadId);
      channels.dockReveal.request();
    };
    const openChatIndex = async () => {
      await latest.current.go({ kind: "chat-index" }, { replace: false });
    };
    const showChatScreen = async () => {
      const threadId = latest.current.currentThreadId;
      await latest.current.go(
        threadId ? { kind: "chat", chatId: threadId } : { kind: "chat-index" },
        { replace: false },
      );
    };
    const commands = {
      openChat,
      openChatIndex,
      showChatScreen,
      openNewChat: async () => {
        if (onChatScreen()) return openChatIndex();
        remember(null);
        channels.dockReveal.request();
        setNewChatFocusRequestId(nextFocusRequestId.current++);
      },
      acceptCreatedChat: (threadId: string) => {
        remember(threadId);
        if (onChatScreen())
          void latest.current.go({ kind: "chat", chatId: threadId }, { replace: false });
      },
      forgetChat: (threadId: string) => {
        if (latest.current.currentThreadId === threadId) remember(null);
      },
      registerDockReveal: channels.dockReveal.register,
      consumeNewChatFocusRequest: (id: number) => {
        setNewChatFocusRequestId((current) => (current === id ? null : current));
      },
    };
    return { remember, commands };
  }, [channels]);

  useEffect(() => {
    if (urlChatId) remember(urlChatId);
  }, [urlChatId, remember]);
  useMissingChatFallback(accountId, surfaceThreadId, () => {
    remember(null);
    // Replace, never push: Back must not land on the missing chat again.
    if (latest.current.urlChatId) void latest.current.go({ kind: "chat-index" }, { replace: true });
  });
  // Opening a conversation reveals it where the writer already is: point the
  // dock at it and call the registered dock reveal, or navigate on the Chat
  // screen. One place, shared by every shell.
  useConversationRevealRouting(commands.openChat);

  return useMemo(
    () => ({ ...commands, display, recoveringFirstSend, newChatFocusRequestId }),
    [commands, display, recoveringFirstSend, newChatFocusRequestId],
  );
}

/**
 * A chat the server no longer has (deleted elsewhere, or a stale link) is let
 * go. A 404 recorded before the chat was last pending creation is the benign
 * race of a first send, not a missing chat, even once the send is acknowledged.
 */
function useMissingChatFallback(accountId: string, threadId: string | null, onMissing: () => void) {
  const pendingCreation = useIsThreadPendingCreation(threadId);
  const firstSend = !!threadId && readFirstSendSubmission(accountId, threadId) !== null;
  const pending = pendingCreation || firstSend;
  const { error, errorUpdatedAt } = useQuery({
    ...threadSnapshotQueryOptions(threadId ?? ""),
    enabled: false,
  });
  const notFound = !!error && "status" in error && error.status === 404;
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

/**
 * One-shot requests delivered to the latest registered handler; a request with
 * no handler registered is simply dropped. Only one shell is ever mounted at a
 * time, so a registration is already live before any command can fire it.
 */
function createChannel() {
  const handlers: Array<() => void> = [];
  return {
    request() {
      handlers.at(-1)?.();
    },
    register(handler: () => void) {
      handlers.push(handler);
      return () => {
        const index = handlers.lastIndexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
}

function createChannels() {
  return { dockReveal: createChannel() };
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

/** Registers the shell's dock reveal for as long as the shell is mounted. */
export function useDockReveal(reveal: () => void) {
  const { registerDockReveal } = useChatNavigation();
  const latest = useRef(reveal);
  latest.current = reveal;
  useLayoutEffect(() => registerDockReveal(() => latest.current()), [registerDockReveal]);
}
