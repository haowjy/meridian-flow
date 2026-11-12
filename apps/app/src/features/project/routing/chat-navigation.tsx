/**
 * Project chat navigation. Main shows a new chat's composer (`/chats`) or one chat the address names;
 * `useMainArrival` records it in the chat slot. What chat sits beside a document is the side's
 * resolution (`side/side-item.ts`), not this. Every way of opening a chat in main navigates there.
 *
 * Placement follows `features/project/.context/pane-state-machine.md`: change that page's rules and
 * diagrams with any change here.
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
import { threadAvailability } from "@/client/chat-submissions/thread-availability";
import { dropMainTabChat } from "@/client/project-shell/main-tabs";
import {
  readLastShownChat,
  useLastShownChat,
  writeLastShownChat,
} from "@/client/project-shell/store";
import { useThreadSnapshotCache } from "@/client/query/thread-snapshot-query";
import { useIsThreadPendingCreation } from "@/client/stores";
import type { ProjectDestination } from "./project-address";
import type { NavigationSettlement } from "./project-navigation";
import type { NavigationOptions } from "./project-route";

/** The chat main shows: a new chat's composer, or the chat the address names. Null when main holds no chat. */
export type ChatDisplay = { kind: "new" } | { kind: "thread"; threadId: string };

export type ChatNavigation = {
  /** The chat main shows; null when main holds no chat. */
  display: ChatDisplay | null;
  /** The chat slot: the last chat on screen, in either pane. */
  lastShownChatId: string | null;
  /** Main goes to this chat: every chat door (a row, a mention, a link) is this one open. */
  openChat: (threadId: string, options?: { replace?: boolean }) => Promise<void>;
  /** Main goes to a new chat's composer, which takes focus unless `focus` is false. */
  openNewChat: (options?: { replace?: boolean; focus?: boolean }) => Promise<void>;
  /**
   * A just-sent new chat. Sent from main's composer it becomes main's chat; sent from the side's
   * composer it fills the chat slot and stays there, beside main.
   */
  acceptCreatedChat: (threadId: string) => void;
  /** A deleted chat leaves the chat slot, and the side lets go of it. */
  forgetChat: (threadId: string) => void;
  /**
   * One-shot New chat focus intent for the pinned empty composer. Non-null
   * exactly once per `openNewChat` call, until the composer that focused
   * consumes it; a composer that mounts fresh already sees it in this same
   * render, so mount timing never races a hold window.
   */
  newChatFocusRequestId: number | null;
  consumeNewChatFocusRequest: (id: number) => void;
};

type Go = (
  destination: ProjectDestination,
  options: NavigationOptions,
) => Promise<NavigationSettlement>;

/** Owns the chat commands for one project route; returns the provider value. */
export function useProjectChatNavigation({
  accountId,
  projectId,
  mainChat,
  go,
}: {
  accountId: string;
  projectId: string;
  /** The chat the address names, or a new chat; null when main holds no chat. */
  mainChat: ChatDisplay | null;
  go: Go;
}): ChatNavigation {
  const lastShownChatId = useLastShownChat(accountId, projectId);
  const urlChatId = mainChat?.kind === "thread" ? mainChat.threadId : null;
  const display = mainChat;
  const surfaceThreadId = urlChatId ?? lastShownChatId;
  const [newChatRequest, setNewChatRequest] = useState<number | null>(null);
  const nextFocusRequestId = useRef(1);
  const mainKind = mainChat?.kind ?? null;
  const latest = useRef({ accountId, projectId, mainKind, urlChatId, go });
  latest.current = { accountId, projectId, mainKind, urlChatId, go };

  const { remember, commands } = useMemo(() => {
    const remember = (threadId: string | null) => {
      const { accountId, projectId } = latest.current;
      writeLastShownChat(accountId, projectId, threadId);
    };
    const go = async (destination: ProjectDestination, options: NavigationOptions) => {
      const result = await latest.current.go(destination, options);
      if (result.kind === "failed") throw result.error;
    };
    const openChat = async (threadId: string, options?: { replace?: boolean }) => {
      await go({ kind: "chat", chatId: threadId }, { replace: options?.replace ?? false });
    };
    const commands = {
      openChat,
      openNewChat: async (options?: { replace?: boolean; focus?: boolean }) => {
        if (options?.focus !== false) setNewChatRequest(nextFocusRequestId.current++);
        if (latest.current.mainKind !== "new")
          await go({ kind: "new-chat" }, { replace: options?.replace ?? false });
      },
      acceptCreatedChat: (threadId: string) => {
        // Main's composer navigates and the arrival records the chat; the side's composer sends
        // while main is not a new chat, and the chat stays beside.
        if (latest.current.mainKind === "new")
          void go({ kind: "chat", chatId: threadId }, { replace: false });
        else remember(threadId);
      },
      forgetChat: (threadId: string) => {
        const { accountId, projectId } = latest.current;
        if (readLastShownChat(accountId, projectId) === threadId) remember(null);
        dropMainTabChat(accountId, projectId, threadId);
      },
      consumeNewChatFocusRequest: (id: number) => {
        setNewChatRequest((current) => (current === id ? null : current));
      },
    };
    return { remember, commands };
  }, []);

  useMissingChatFallback(accountId, surfaceThreadId, () => {
    remember(null);
    if (surfaceThreadId) dropMainTabChat(accountId, projectId, surfaceThreadId);
    // Replace, never push: Back must not land on the missing chat again.
    if (latest.current.urlChatId) void go({ kind: "new-chat" }, { replace: true });
  });

  const newChatFocusRequestId = newChatRequest;
  const displayKey = JSON.stringify(display);
  const stableDisplay = useMemo(() => display, [displayKey]);

  return useMemo(
    () => ({
      ...commands,
      display: stableDisplay,
      lastShownChatId,
      newChatFocusRequestId,
    }),
    [commands, stableDisplay, lastShownChatId, newChatFocusRequestId],
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
