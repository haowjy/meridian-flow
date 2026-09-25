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
import type { ScreenKey } from "../shell/screens";
import type { ProjectDestination } from "./project-address";
import type { NavigationOptions } from "./project-route";

export type ChatNavigation = {
  /** The chat the dock shows and the Chat screen reopens; null is no chat. */
  currentThreadId: string | null;
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
   * Delivers an explicit New chat's focus to the empty composer showing it,
   * once: at registration when New chat mounted the composer, or in place.
   */
  registerNewChatFocus: (focus: () => void) => () => void;
};

type Go = (destination: ProjectDestination, options: NavigationOptions) => Promise<unknown>;

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
}): ChatNavigation & { chatThreadId: string | null } {
  const [currentThreadId, setCurrentThreadId] = useState(() =>
    readCurrentChat(accountId, projectId),
  );
  const chatThreadId = urlChatId ?? currentThreadId;
  const [recoveringFirstSend] = useState(
    () => chatThreadId !== null && readFirstSendSubmission(accountId, chatThreadId) !== null,
  );
  const [channels] = useState(createChannels);
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
        channels.newChatFocus.request();
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
      registerNewChatFocus: channels.newChatFocus.register,
    };
    return { remember, commands };
  }, [channels]);

  useEffect(() => {
    if (urlChatId) remember(urlChatId);
  }, [urlChatId, remember]);
  useMissingChatFallback(accountId, chatThreadId, () => {
    remember(null);
    // Replace, never push: Back must not land on the missing chat again.
    if (latest.current.urlChatId) void latest.current.go({ kind: "chat-index" }, { replace: true });
  });

  return useMemo(
    () => ({ ...commands, currentThreadId, recoveringFirstSend, chatThreadId }),
    [commands, currentThreadId, recoveringFirstSend, chatThreadId],
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
 * One-shot requests delivered to the latest registered handler. With none
 * registered, a request waits up to `holdMs` for the next registration (a
 * composer mounted by the same action), then lapses so a later mount never
 * receives it. A zero hold drops it.
 */
function createChannel(holdMs: number) {
  let heldUntil: number | null = null;
  const handlers: Array<() => void> = [];
  return {
    request() {
      const handler = handlers.at(-1);
      if (handler) handler();
      else if (holdMs > 0) heldUntil = Date.now() + holdMs;
    },
    register(handler: () => void) {
      handlers.push(handler);
      const held = heldUntil !== null && Date.now() <= heldUntil;
      heldUntil = null;
      if (held) handler();
      return () => {
        const index = handlers.lastIndexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
}

function createChannels() {
  // The dock's shell is always mounted; focus waits for the composer New chat mounts.
  return { dockReveal: createChannel(0), newChatFocus: createChannel(1000) };
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
