/**
 * Project chat navigation. Main shows a new chat's composer (`/chats`), Recent chats
 * (`/chats/recent`) or one chat the address names;
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

export type ChatDisplay =
  | { kind: "new" }
  | { kind: "chat-recents" }
  | { kind: "thread"; threadId: string };

export type ChatNavigation = {
  display: ChatDisplay | null;
  lastShownChatId: string | null;
  openChat: (threadId: string, options?: { replace?: boolean }) => Promise<NavigationSettlement>;
  openNewChat: (options?: { replace?: boolean; focus?: boolean }) => Promise<NavigationSettlement>;
  openChatRecents: (options?: { replace?: boolean }) => Promise<NavigationSettlement>;
  acceptCreatedChat: (threadId: string) => void;
  forgetChat: (threadId: string) => void;
  newChatFocusRequestId: number | null;
  consumeNewChatFocusRequest: (id: number) => void;
};

type Go = (
  destination: ProjectDestination,
  options: NavigationOptions,
) => Promise<NavigationSettlement>;

export function useProjectChatNavigation({
  accountId,
  projectId,
  mainChat,
  go,
}: {
  accountId: string;
  projectId: string;
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
    const go = (destination: ProjectDestination, options: NavigationOptions) =>
      latest.current.go(destination, options);
    const openChat = (threadId: string, options?: { replace?: boolean }) =>
      go({ kind: "chat", chatId: threadId }, { replace: options?.replace ?? false });
    const commands = {
      openChat,
      openNewChat: async (options?: { replace?: boolean; focus?: boolean }) => {
        if (options?.focus !== false) setNewChatRequest(nextFocusRequestId.current++);
        return latest.current.mainKind === "new"
          ? ({ kind: "applied" } as const)
          : go({ kind: "new-chat" }, { replace: options?.replace ?? false });
      },
      openChatRecents: async (options?: { replace?: boolean }) =>
        latest.current.mainKind === "chat-recents"
          ? ({ kind: "applied" } as const)
          : go({ kind: "chat-recents" }, { replace: options?.replace ?? false }),
      acceptCreatedChat: (threadId: string) => {
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

export function useChatNavigation(): ChatNavigation {
  const navigation = useContext(ChatNavigationContext);
  if (!navigation) throw new Error("Chat navigation requires a project route");
  return navigation;
}
