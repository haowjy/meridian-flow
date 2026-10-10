// @vitest-environment jsdom
/**
 * Chat commands keep the writer's screen: on the Chat screen they navigate;
 * elsewhere they point the dock at the chat and reveal it. The current chat is
 * this browser's own, and a chat the server no longer has is let go.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readCurrentChat } from "@/client/current-chat";
import { threadSnapshotQueryOptions } from "@/client/query/useThreadSnapshotSync";
import { ThreadStoreProvider, useThreadActions } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";
import {
  type ChatNavigation,
  chatSurfaceThreadId,
  useProjectChatNavigation,
} from "./chat-navigation";
import type { ProjectDestination } from "./project-address";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = "writer";
const PROJECT = "project";

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let go: ReturnType<typeof vi.fn<(destination: ProjectDestination) => Promise<void>>>;
let navigation: ChatNavigation;
let effects: ReturnType<typeof vi.fn<(callback?: () => void) => void>>;
let threadActions: ReturnType<typeof useThreadActions>;

function Harness(props: { activeScreen: ScreenKey; urlChatId: string | null }) {
  threadActions = useThreadActions();
  navigation = useProjectChatNavigation({
    accountId: ACCOUNT,
    projectId: PROJECT,
    go: async (destination, options) => {
      await go(destination);
      effects(options.afterCommit);
      return { kind: "applied" };
    },
    ...props,
  });
  return null;
}

function render(activeScreen: ScreenKey, urlChatId: string | null = null) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <ThreadStoreProvider now={0}>
          <Harness activeScreen={activeScreen} urlChatId={urlChatId} />
        </ThreadStoreProvider>
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  client = new QueryClient();
  go = vi.fn(async () => undefined);
  effects = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  window.localStorage.clear();
});

it("shows a sent chat on the Chat screen and only remembers it elsewhere", () => {
  render("chat");
  act(() => navigation.acceptCreatedChat("sent"));
  expect(go).toHaveBeenCalledWith({ kind: "chat", chatId: "sent" });
  expect(readCurrentChat(ACCOUNT, PROJECT)).toBe("sent");
  // The route settles the URL onto the new chat; re-rendering with it reflects
  // the thread variant (the hook alone cannot observe the navigation completing).
  render("chat", "sent");
  expect(navigation.display).toEqual({ kind: "thread", threadId: "sent" });

  go.mockClear();
  render("context");
  act(() => navigation.acceptCreatedChat("docked"));
  expect(go).not.toHaveBeenCalled();
  expect(chatSurfaceThreadId(navigation.display)).toBe("docked");
});

it("keeps a first send whose pre-creation 404 is still cached once it is acknowledged", () => {
  render("chat", "sent");
  const snapshot = client
    .getQueryCache()
    .build(client, { queryKey: threadSnapshotQueryOptions("sent").queryKey });
  act(() => threadActions.markPendingCreation({ threadId: "sent" }));
  act(() =>
    snapshot.setState({
      status: "error",
      error: Object.assign(new Error("missing"), { status: 404 }),
      errorUpdatedAt: Date.now() - 1000,
    }),
  );
  act(() => threadActions.clearPendingCreation({ threadId: "sent" }));
  expect(navigation.display).toEqual({ kind: "thread", threadId: "sent" });
  expect(go).not.toHaveBeenCalledWith({ kind: "chat-index" });
});

it("rail switches use the remembered current chat and forward the post-commit effect", async () => {
  render("context");
  act(() => navigation.acceptCreatedChat("remembered"));
  const commit = vi.fn();
  await act(async () => {
    await navigation.showChatScreen({ afterCommit: commit });
  });
  expect(go).toHaveBeenCalledWith({ kind: "chat", chatId: "remembered" });
  expect(effects).toHaveBeenCalledWith(commit);
  expect(commit).not.toHaveBeenCalled();
  go.mockClear();
  await act(async () => {
    await navigation.showChatScreen();
  });
  expect(go).toHaveBeenCalledWith({ kind: "chat", chatId: "remembered" });
});

it("rail switches with no current chat use the index and still forward the hand-off", async () => {
  render("context");
  const commit = vi.fn();
  await act(async () => {
    await navigation.showChatScreen({ afterCommit: commit });
  });
  expect(go).toHaveBeenCalledWith({ kind: "chat-index" });
  expect(effects).toHaveBeenCalledWith(commit);
});
