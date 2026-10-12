// @vitest-environment jsdom
/**
 * Chat commands keep the writer's screen: on the Chat screen they navigate;
 * elsewhere they point the dock at the chat and reveal it. The current chat is
 * this tab's own, and a chat the server no longer has is let go.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import { getChatSubmissionEpoch } from "@/client/chat-submissions";
import { readCurrentChat } from "@/client/current-chat";
import { withThreadSnapshotEpoch } from "@/client/query/thread-snapshot-epoch";
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

const copies = vi.hoisted(() => ({
  forget: vi.fn<typeof import("@/client/chat-submissions")["reportChatAvailability"]>(
    async () => "forgotten",
  ),
}));
vi.mock("@/client/chat-submissions", async (actual) => ({
  ...(await actual<typeof import("@/client/chat-submissions")>()),
  reportChatAvailability: copies.forget,
}));

vi.mock("@/client/chat-submissions/adapters/browser-lock", async () => {
  const { MemorySubmissionLock } = await import("@/client/chat-submissions/adapters/memory-lock");
  return { browserSubmissionLock: new MemorySubmissionLock() };
});

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
  copies.forget.mockReset();
  copies.forget.mockResolvedValue("forgotten");
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

it("keeps a first send whose pre-creation 404 is still cached once it is acknowledged", async () => {
  render("chat", "sent");
  const snapshot = client
    .getQueryCache()
    .build(client, { queryKey: threadSnapshotQueryOptions("sent").queryKey });
  act(() => threadActions.markPendingCreation({ threadId: "sent" }));
  await act(async () =>
    snapshot.setState({
      status: "error",
      error: await withThreadSnapshotEpoch(getChatSubmissionEpoch(), async () => {
        throw new MeridianApiError(
          {
            code: "thread_not_found",
            details: { authenticatedUserId: ACCOUNT },
            message: "missing",
            source: "system",
            retryable: false,
          },
          404,
        );
      }).catch((error) => error),
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

it("forgets browser copies before repairing a definitive missing-chat route", async () => {
  let finish!: (value: "forgotten") => void;
  copies.forget.mockReturnValueOnce(
    new Promise<"forgotten">((resolve) => {
      finish = resolve;
    }),
  );
  render("chat", "gone");
  const query = client
    .getQueryCache()
    .build(client, { queryKey: threadSnapshotQueryOptions("gone").queryKey });
  await act(async () => {
    query.setState({
      error: await withThreadSnapshotEpoch(getChatSubmissionEpoch(), async () => {
        throw new MeridianApiError(
          {
            code: "thread_not_found",
            details: { authenticatedUserId: ACCOUNT },
            message: "missing",
            source: "system",
            retryable: false,
          },
          404,
        );
      }).catch((error) => error),
      errorUpdatedAt: Date.now(),
      status: "error",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(copies.forget).toHaveBeenCalledWith(
    ACCOUNT,
    "gone",
    getChatSubmissionEpoch(),
    "not-found",
    expect.any(Object),
  );
  expect(go).not.toHaveBeenCalled();
  await act(async () => {
    finish("forgotten");
  });
  expect(go).toHaveBeenCalledWith({ kind: "chat-index" });
});
it("does not repair or forget an unrelated 404", async () => {
  render("chat", "live");
  const query = client
    .getQueryCache()
    .build(client, { queryKey: threadSnapshotQueryOptions("live").queryKey });
  await act(async () => {
    query.setState({
      error: Object.assign(new Error("another resource"), { status: 404 }),
      errorUpdatedAt: Date.now(),
      status: "error",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(copies.forget).not.toHaveBeenCalled();
  expect(go).not.toHaveBeenCalled();
});

it("repairs a missing-chat route even when the journal is unreadable", async () => {
  const actual = await vi.importActual<typeof import("@/client/chat-submissions")>(
    "@/client/chat-submissions",
  );
  actual.bindChatSubmissions(ACCOUNT);
  copies.forget.mockImplementation(actual.forgetCreatedChat);
  window.localStorage.setItem(`${actual.CHAT_SUBMISSIONS_STORAGE_PREFIX}${ACCOUNT}:record`, "{}");
  const getItem = Storage.prototype.getItem;
  const blocked = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
    this: Storage,
    key,
  ) {
    if (key.startsWith(actual.CHAT_SUBMISSIONS_STORAGE_PREFIX)) throw new Error("blocked journal");
    return getItem.call(this, key);
  });
  try {
    render("chat", "gone");
    const query = client
      .getQueryCache()
      .build(client, { queryKey: threadSnapshotQueryOptions("gone").queryKey });
    await act(async () => {
      query.setState({
        status: "error",
        errorUpdatedAt: Date.now(),
        error: await withThreadSnapshotEpoch(getChatSubmissionEpoch(), async () => {
          throw new MeridianApiError(
            {
              code: "thread_not_found",
              details: { authenticatedUserId: ACCOUNT },
              message: "missing",
              source: "system",
              retryable: false,
            },
            404,
          );
        }).catch((error) => error),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(go).toHaveBeenCalledWith({ kind: "chat-index" });
  } finally {
    blocked.mockRestore();
  }
});

it.each([
  "creation",
  "stale",
] as const)("does not repair when forget reports %s", async (result) => {
  copies.forget.mockResolvedValueOnce(result);
  render("chat", "creating");
  const query = client
    .getQueryCache()
    .build(client, { queryKey: threadSnapshotQueryOptions("creating").queryKey });
  await act(async () => {
    query.setState({
      status: "error",
      errorUpdatedAt: Date.now(),
      error: await withThreadSnapshotEpoch(getChatSubmissionEpoch(), async () => {
        throw new MeridianApiError(
          {
            code: "thread_not_found",
            details: { authenticatedUserId: ACCOUNT },
            message: "missing",
            source: "system",
            retryable: false,
          },
          404,
        );
      }).catch((error) => error),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(copies.forget).toHaveBeenCalled();
  expect(go).not.toHaveBeenCalled();
});

it("leaves a creation-bearing cohort on its O4 destination", async () => {
  const actual = await vi.importActual<typeof import("@/client/chat-submissions")>(
    "@/client/chat-submissions",
  );
  actual.bindChatSubmissions(ACCOUNT);
  actual.recordChatSubmission(ACCOUNT, {
    recordId: "first",
    submissionId: "first",
    threadId: "creating",
    projectId: PROJECT,
    createdAt: new Date().toISOString(),
    text: "First words",
    blocks: [{ type: "text", text: "First words" }],
    references: [],
    activatedSkillSlugs: [],
    creation: {
      title: "Creating",
      workId: null,
      agentSelection: { catalogEntryId: "general", definitionRevisionId: "rev" },
      agentName: "General",
      agentSlug: "general",
    },
  });
  copies.forget.mockImplementation(actual.forgetCreatedChat);
  render("chat", "creating");
  const query = client
    .getQueryCache()
    .build(client, { queryKey: threadSnapshotQueryOptions("creating").queryKey });
  await act(async () => {
    query.setState({
      status: "error",
      errorUpdatedAt: Date.now(),
      error: await withThreadSnapshotEpoch(getChatSubmissionEpoch(), async () => {
        throw new MeridianApiError(
          {
            code: "thread_not_found",
            details: { authenticatedUserId: ACCOUNT },
            message: "missing",
            source: "system",
            retryable: false,
          },
          404,
        );
      }).catch((error) => error),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(copies.forget).not.toHaveBeenCalled();
  expect(go).not.toHaveBeenCalled();
  expect(actual.readChatSubmissions(ACCOUNT)).toHaveLength(1);
});

it("repairs a missing-chat route even if forgetting throws", async () => {
  vi.stubGlobal("reportError", vi.fn());
  copies.forget.mockRejectedValueOnce(new Error("lock unavailable"));
  render("chat", "gone");
  const query = client.getQueryCache().build(client, {
    queryKey: threadSnapshotQueryOptions("gone").queryKey,
  });
  await act(async () => {
    query.setState({
      status: "error",
      errorUpdatedAt: Date.now(),
      error: await withThreadSnapshotEpoch(getChatSubmissionEpoch(), async () => {
        throw new MeridianApiError(
          {
            code: "thread_not_found",
            message: "missing",
            retryable: false,
            source: "system",
            details: { authenticatedUserId: ACCOUNT },
          },
          404,
        );
      }).catch((error) => error),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(go).toHaveBeenCalledWith({ kind: "chat-index" });
});

it("reports the snapshot error's request-start epoch, not the route's current epoch", async () => {
  copies.forget.mockResolvedValueOnce("stale");
  render("chat", "gone");
  const startEpoch = getChatSubmissionEpoch() - 1;
  const error = await withThreadSnapshotEpoch(startEpoch, async () => {
    throw new MeridianApiError(
      {
        code: "thread_not_found",
        details: { authenticatedUserId: ACCOUNT },
        message: "missing",
        source: "system",
        retryable: false,
      },
      404,
    );
  }).catch((error) => error);
  const query = client
    .getQueryCache()
    .build(client, { queryKey: threadSnapshotQueryOptions("gone").queryKey });
  await act(async () => {
    query.setState({ error, errorUpdatedAt: Date.now(), status: "error" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(copies.forget).toHaveBeenCalledWith(
    ACCOUNT,
    "gone",
    startEpoch,
    "not-found",
    expect.any(Object),
  );
  expect(go).not.toHaveBeenCalled();
});
