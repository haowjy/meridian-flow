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
import { readCurrentChat, writeCurrentChat } from "@/client/current-chat";
import { threadSnapshotQueryOptions } from "@/client/query/useThreadSnapshotSync";
import { ThreadStoreProvider } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";
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
let navigation: ChatNavigation & { chatThreadId: string | null };

function Harness(props: { activeScreen: ScreenKey; urlChatId: string | null }) {
  navigation = useProjectChatNavigation({
    accountId: ACCOUNT,
    projectId: PROJECT,
    go: (destination) => go(destination),
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
});

afterEach(() => {
  act(() => root.unmount());
  window.localStorage.clear();
});

it("navigates on the Chat screen and reveals the dock elsewhere", async () => {
  render("chat");
  await act(() => navigation.openChat("a"));
  expect(go).toHaveBeenCalledWith({ kind: "chat", chatId: "a" });

  go.mockClear();
  render("context");
  const reveal = vi.fn();
  act(() => void navigation.registerDockReveal(reveal));
  await act(() => navigation.openChat("b"));
  expect(go).not.toHaveBeenCalled();
  expect(reveal).toHaveBeenCalledTimes(1);
  expect(navigation.currentThreadId).toBe("b");
  expect(readCurrentChat(ACCOUNT, PROJECT)).toBe("b");
});

it("starts a new chat on the index, or in the dock with its composer focused", async () => {
  writeCurrentChat(ACCOUNT, PROJECT, "a");
  render("chat");
  await act(() => navigation.openNewChat());
  expect(go).toHaveBeenCalledWith({ kind: "chat-index" });
  expect(navigation.currentThreadId).toBe("a");

  render("work");
  const focus = vi.fn();
  await act(() => navigation.openNewChat());
  expect(navigation.currentThreadId).toBeNull();
  // New chat mounted the empty composer after the request: it still gets focus, once.
  act(() => void navigation.registerNewChatFocus(focus));
  act(() => void navigation.registerNewChatFocus(focus));
  expect(focus).toHaveBeenCalledTimes(1);
});

it("shows a sent chat on the Chat screen and only remembers it elsewhere", () => {
  render("chat");
  act(() => navigation.acceptCreatedChat("sent"));
  expect(go).toHaveBeenCalledWith({ kind: "chat", chatId: "sent" });
  expect(navigation.currentThreadId).toBe("sent");

  go.mockClear();
  render("context");
  act(() => navigation.acceptCreatedChat("docked"));
  expect(go).not.toHaveBeenCalled();
  expect(navigation.chatThreadId).toBe("docked");
});

it("forgets only the deleted chat when it is current", () => {
  writeCurrentChat(ACCOUNT, PROJECT, "a");
  render("work");
  act(() => navigation.forgetChat("other"));
  expect(navigation.currentThreadId).toBe("a");
  act(() => navigation.forgetChat("a"));
  expect(navigation.currentThreadId).toBeNull();
});

it("remembers the chat in the URL, and replaces a missing one with the index", () => {
  render("chat", "gone");
  expect(readCurrentChat(ACCOUNT, PROJECT)).toBe("gone");
  act(() =>
    client
      .getQueryCache()
      .build(client, { queryKey: threadSnapshotQueryOptions("gone").queryKey })
      .setState({ status: "error", error: Object.assign(new Error("missing"), { status: 404 }) }),
  );
  render("chat", "gone");
  expect(navigation.currentThreadId).toBeNull();
  expect(go).toHaveBeenCalledWith({ kind: "chat-index" });
});
