// @vitest-environment jsdom
/**
 * A sent chat takes main when main is a new chat's composer; sent from the side's composer it is held
 * beside main. The last chat is this tab's own, and a chat the server no longer has is let go.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - tab-local remembered chat navigation
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readHeldPick, readLastChat } from "@/client/project-shell/store";
import { threadSnapshotQueryOptions } from "@/client/query/thread-snapshot-query";
import { ThreadStoreProvider, useThreadActions } from "@/client/stores";
import { type ChatNavigation, useProjectChatNavigation } from "./chat-navigation";
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

type MainChat = Parameters<typeof useProjectChatNavigation>[0]["mainChat"];

function Harness({ mainChat }: { mainChat: MainChat }) {
  threadActions = useThreadActions();
  navigation = useProjectChatNavigation({
    accountId: ACCOUNT,
    projectId: PROJECT,
    go: async (destination, options) => {
      await go(destination);
      effects(options.afterCommit);
      return { kind: "applied" };
    },
    mainChat,
  });
  return null;
}

function render(mainChat: MainChat) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <ThreadStoreProvider now={0}>
          <Harness mainChat={mainChat} />
        </ThreadStoreProvider>
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  container = document.createElement("div");
  root = createRoot(container);
  client = new QueryClient();
  go = vi.fn(async () => undefined);
  effects = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
});

it("shows a sent chat in main from the new-chat composer and holds it beside a document", () => {
  render({ kind: "new" });
  act(() => navigation.acceptCreatedChat("sent"));
  expect(go).toHaveBeenCalledWith({ kind: "chat", chatId: "sent" });
  expect(readLastChat(ACCOUNT, PROJECT)).toBe("sent");
  // The route settles the URL onto the new chat; re-rendering with it reflects
  // the thread variant (the hook alone cannot observe the navigation completing).
  render({ kind: "thread", threadId: "sent" });
  expect(navigation.display).toEqual({ kind: "thread", threadId: "sent" });

  go.mockClear();
  render(null);
  act(() => navigation.acceptCreatedChat("docked"));
  expect(go).not.toHaveBeenCalled();
  expect(readHeldPick(ACCOUNT, PROJECT)).toEqual({ kind: "chat", chatId: "docked" });
});

it("keeps a first send whose pre-creation 404 is still cached once it is acknowledged", () => {
  render({ kind: "thread", threadId: "sent" });
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
  expect(go).not.toHaveBeenCalledWith({ kind: "new-chat" });
});
