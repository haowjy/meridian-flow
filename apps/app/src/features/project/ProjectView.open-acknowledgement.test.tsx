/** Production-shaped ProjectView ownership and real visible-Chat claim contracts. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadStoreProvider, useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => parts.join(""),
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@/client/query/useWorks", () => ({ useWorks: () => ({ works: [] }) }));
vi.mock("@/client/working-set", () => ({
  hydrateWorkingSet: () => ({ status: "local" }),
  retryWorkingSetHydration: vi.fn(),
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  DraftReviewProvider: ({ children }: { children: ReactNode }) => children,
  useDraftReview: () => ({ groups: [] }),
}));
vi.mock("@/features/chat/ChatView", () => ({
  ChatView: ({ threadId }: { threadId: string }) => <div>Conversation {threadId}</div>,
}));
vi.mock("@/features/chat/review-prose-focus", () => ({
  useReviewProseFocus: () => ({ collapsedSlots: [], release: vi.fn() }),
}));
vi.mock("@/features/chat/conversation-reveal", () => ({
  useConversationRevealRouting: vi.fn(),
}));
vi.mock("@/hooks/use-phone-shell", () => ({ usePhoneShell: () => false }));
vi.mock("./chat/chat-thread-resolution", () => ({
  useResolvedChatThread: (_projectId: string, threadId: string | null) => ({
    resolvedThreadId: threadId,
    projectThreads: [],
  }),
}));
vi.mock("./layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./layout")>();
  const layout = {
    threads: { slot: "rail-l", width: 280, collapsed: true },
    chat: { slot: "dock", width: 360, collapsed: false },
    "context-viewer": { slot: null, width: 0, collapsed: true },
    "context-rail": { slot: null, width: 0, collapsed: true },
  };
  return {
    ...actual,
    useProjectLayout: () => layout,
    useProjectSurfacePrefsStore: (selector: (state: { _hydrated: boolean }) => unknown) =>
      selector({ _hydrated: true }),
    useProjectSurfacePrefsActions: () => ({
      setSurfaceCollapsed: vi.fn(),
      setSurfaceWidth: vi.fn(),
      setDockCollapsed: vi.fn(),
      setDockWidth: vi.fn(),
    }),
  };
});
vi.mock("./shell/ProjectShell", () => ({
  ProjectShell: ({
    children,
    surfaces,
  }: {
    children: ReactNode;
    surfaces: Array<{ id: string; children: ReactNode }>;
  }) => (
    <>
      {children}
      {surfaces.find((surface) => surface.id === "chat")?.children}
    </>
  ),
}));
vi.mock("./HomePaneController", () => ({
  HomePaneController: ({ onOpenThread }: { onOpenThread: (threadId: string) => void }) => (
    <>
      <button type="button" onClick={() => onOpenThread("thread-a")}>
        Open A
      </button>
      <button type="button" onClick={() => onOpenThread("thread-c")}>
        Open C
      </button>
    </>
  ),
}));
vi.mock("./shell/LeftSidebar", () => ({ LeftSidebar: () => null }));
vi.mock("./shell/ContextSidebar", () => ({ ContextSidebar: () => null }));
vi.mock("./ContextPaneController", () => ({ ContextViewerSurfaceController: () => null }));
vi.mock("./ChatPaneController", () => ({ ChatPaneController: () => null }));
vi.mock("./context/TreeCreationProvider", () => ({
  TreeCreationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./chat/ProjectChatContextNavigationProvider", () => ({
  ProjectChatContextNavigationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./chat/SubagentBanner", () => ({ SubagentBanner: () => null }));
vi.mock("./chat/SubagentTaskCard", () => ({ SubagentTaskCard: () => null }));
vi.mock("./working-set-tab-seeding", () => ({
  contextDeskReconciliation: () => "local-only",
  seedWorkingSetTabs: vi.fn(),
  validateContextDeskTabs: vi.fn(),
}));

const projectId = "project-1";
const thread = (id: string) => ({
  id,
  projectId,
  workId: "work-1",
  parentThreadId: null,
  title: id,
  kind: "primary" as const,
  attention: "unread" as const,
  runningTurnId: null,
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
});
const threads = [thread("thread-a"), thread("thread-b"), thread("thread-c")];
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/client/query/useThreadSnapshotSync", () => ({
  useThreadSnapshotSync: (threadId: string) => ({
    thread: thread(threadId),
    attention: "unread",
    liveState: null,
    nextSeq: "1",
    settled: true,
    isError: false,
    refetch: vi.fn(),
  }),
}));

const { ProjectView } = await import("./ProjectView");

type Patch = { threadId: string; body: unknown; resolve: (response: Response) => void };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function controlledPatches() {
  const patches: Patch[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((done) => {
        resolve = done;
      });
      const match = String(input).match(/threads\/([^/]+)\/user-state/);
      patches.push({
        threadId: match?.[1] ?? "unknown",
        body: JSON.parse(String(init?.body)),
        resolve,
      });
      return promise;
    }),
  );
  return patches;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("condition was not reached");
}

const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );

function projectProps(onSelectThread: (threadId: string) => Promise<void>) {
  return {
    projectId,
    workingSet: { status: "absent" as const },
    workingSetSyncEnabled: false,
    activeScreen: "home" as const,
    activeThreadId: null,
    routeWork: { status: "absent" as const },
    routeCommands: {
      openHome: vi.fn(async () => undefined),
      openChat: vi.fn(async () => undefined),
      openDockThread: vi.fn(async () => undefined),
      openWork: vi.fn(async () => undefined),
      closeWork: vi.fn(async () => undefined),
      openWorkContext: vi.fn(async () => undefined),
    },
    activeContextScheme: null,
    activeContextFolder: null,
    activeContextPath: null,
    resultsOpen: false,
    onSelectScreen: vi.fn(),
    onSelectThread,
    onSelectDockThread: vi.fn(),
    onSelectContextScheme: vi.fn(),
    onExitContextScheme: vi.fn(),
    onSelectContextFolder: vi.fn(),
    onOpenContextTarget: vi.fn(),
    onOpenResults: vi.fn(),
    onCloseResults: vi.fn(),
  };
}

function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  window.matchMedia = () =>
    ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as never;
  return (
    <QueryClientProvider client={client}>
      <ThreadStoreProvider now={Date.now()}>{children}</ThreadStoreProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  useContextTabsStore.setState({ _deskHydrated: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("ProjectView open acknowledgement ownership with its visible Chat claimant", () => {
  it("keeps the pre-navigation B lease, then gives A only its exact transfer", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const patches = controlledPatches();
    const navigation = deferred<void>();

    function Harness() {
      const [activeThreadId, setActiveThreadId] = useState("thread-b");
      return (
        <>
          <button type="button" onClick={() => setActiveThreadId("thread-a")}>
            Commit A
          </button>
          <ProjectView
            {...projectProps(() => navigation.promise)}
            activeThreadId={activeThreadId}
          />
        </>
      );
    }

    await withReactRoot(
      <Providers client={client}>
        <Harness />
      </Providers>,
      async () => {
        await waitFor(() => patches.length === 1);
        expect(patches[0]).toMatchObject({ threadId: "thread-b", body: { isUnread: false } });

        await act(async () => button("Open A")?.click());
        await waitFor(() => patches.length === 2);
        expect(document.body.textContent).toContain("Conversation thread-b");
        expect(patches[1]).toMatchObject({ threadId: "thread-a", body: { isUnread: false } });

        await act(async () => button("Commit A")?.click());
        await waitFor(() => document.body.textContent?.includes("Conversation thread-a") === true);
        expect(patches).toHaveLength(2);

        patches[1]?.resolve(json({ message: "offline" }, 503));
        await waitFor(() => document.body.textContent?.includes("couldn’t save") === true);
        await act(async () => navigation.resolve());
      },
      { drainMacrotask: true },
    );
  });

  it.each([
    "rejection",
    "settled mismatch",
  ] as const)("retires A after navigation %s without handing it to visible B", async (scenario) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const patches = controlledPatches();
    const firstNavigation = deferred<void>();
    let opening = 0;

    function Harness() {
      const [activeThreadId, setActiveThreadId] = useState("thread-b");
      return (
        <>
          <button type="button" onClick={() => setActiveThreadId("thread-a")}>
            Direct A
          </button>
          <ProjectView
            {...projectProps(() => {
              opening += 1;
              return opening === 1 ? firstNavigation.promise : Promise.resolve();
            })}
            activeThreadId={activeThreadId}
          />
        </>
      );
    }

    await withReactRoot(
      <Providers client={client}>
        <Harness />
      </Providers>,
      async () => {
        await waitFor(() => patches.length === 1);
        await act(async () => button("Open A")?.click());
        await waitFor(() => patches.length === 2);
        patches[1]?.resolve(json({ message: "A offline" }, 503));
        await act(async () => {
          if (scenario === "rejection") firstNavigation.reject(new Error("blocked"));
          else firstNavigation.resolve();
          await Promise.resolve();
        });
        expect(document.body.textContent).toContain("Conversation thread-b");
        expect(document.body.textContent).not.toContain("couldn’t save");

        await act(async () => button("Direct A")?.click());
        await waitFor(() => patches.length === 3);
        expect(patches[2]).toMatchObject({ threadId: "thread-a", body: { isUnread: false } });
      },
      { drainMacrotask: true },
    );
  });

  it("retires a superseded A while C is claimed by the persistent Chat", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const patches = controlledPatches();
    const navigations = new Map<string, ReturnType<typeof deferred<void>>>();

    function Harness() {
      const [activeThreadId, setActiveThreadId] = useState("thread-b");
      return (
        <>
          <button type="button" onClick={() => setActiveThreadId("thread-c")}>
            Commit C
          </button>
          <button type="button" onClick={() => setActiveThreadId("thread-a")}>
            Direct A
          </button>
          <ProjectView
            {...projectProps((threadId) => {
              const navigation = deferred<void>();
              navigations.set(threadId, navigation);
              return navigation.promise;
            })}
            activeThreadId={activeThreadId}
          />
        </>
      );
    }

    await withReactRoot(
      <Providers client={client}>
        <Harness />
      </Providers>,
      async () => {
        await waitFor(() => patches.length === 1);
        await act(async () => button("Open A")?.click());
        await act(async () => button("Open C")?.click());
        await waitFor(() => patches.length === 3);

        await act(async () => button("Commit C")?.click());
        expect(patches).toHaveLength(3);
        patches[1]?.resolve(json({ message: "A offline" }, 503));
        await act(async () => navigations.get("thread-a")?.resolve());
        expect(document.body.textContent).not.toContain("couldn’t save");

        await act(async () => button("Direct A")?.click());
        await waitFor(() => patches.length === 4);
        expect(patches[3]?.threadId).toBe("thread-a");
      },
      { drainMacrotask: true },
    );
  });
});
