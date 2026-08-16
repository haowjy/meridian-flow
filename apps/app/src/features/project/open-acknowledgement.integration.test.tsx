// @vitest-environment jsdom
/** Rendered Home/Chat caller contracts for visible-chat open operations. */

import { I18nProvider } from "@lingui/react";
import type { HomeChatFeedPage, ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  type ReactElement,
  type ReactNode,
  StrictMode,
  useCallback,
  useLayoutEffect,
  useState,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupHomeFeed } from "@/client/query/home-chat-feed-cache";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import {
  type OpenAcknowledgementTransfer,
  prepareHomeOpenAcknowledgement,
} from "@/client/query/visible-thread-open-acknowledgements";
import { ThreadStoreProvider } from "@/client/stores";
import { AnnouncementRegion } from "@/components/app/AnnouncementRegion";
import { i18n } from "@/lib/i18n";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ChatScreen } from "./chat/ChatScreen";
import { ChatSurface } from "./chat/ChatSurface";
import { useDockViewStore } from "./dock/dock-view-store";
import { HomeScreen } from "./home/HomeScreen";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => parts.join(""),
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((message, part, index) => `${message}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@/components/ui/dropdown-menu", async () => {
  const React = await import("react");
  const Menu = React.createContext<{ open: boolean; setOpen: (open: boolean) => void }>({
    open: false,
    setOpen: () => undefined,
  });
  return {
    DropdownMenu: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      return <Menu.Provider value={{ open, setOpen }}>{children}</Menu.Provider>;
    },
    DropdownMenuTrigger: ({ children }: { children: ReactElement }) => {
      const menu = React.useContext(Menu);
      return React.cloneElement(children, { onClick: () => menu.setOpen(true) } as object);
    },
    DropdownMenuContent: ({ children }: { children: ReactNode }) => {
      const menu = React.useContext(Menu);
      return menu.open ? <div role="menu">{children}</div> : null;
    },
    DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
      <button type="button" role="menuitem" onClick={onSelect}>
        {children}
      </button>
    ),
  };
});
vi.mock("@/features/chat/ChatView", () => ({
  ChatView: ({ threadId }: { threadId: string }) => <div>Conversation {threadId}</div>,
}));
vi.mock("./home/NewThreadComposerToolbar", () => ({ NewThreadComposerToolbar: () => null }));
vi.mock("./chat/ProjectChatContextNavigationProvider", () => ({
  ProjectChatContextNavigationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./chat/SubagentBanner", () => ({ SubagentBanner: () => null }));
vi.mock("./chat/SubagentTaskCard", () => ({ SubagentTaskCard: () => null }));
vi.mock("./dock/DockChangesView", () => ({
  DockChangesView: () => <div>Pending changes</div>,
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    groups: [
      {
        documentId: "document-1",
        documentName: "Chapter one",
        contextPath: "manuscript://chapter-one.md",
        drafts: [
          {
            draftId: "draft-1",
            status: "active",
            updatedAt: "2026-08-13T00:00:00.000Z",
          },
        ],
      },
    ],
  }),
}));

const thread = {
  id: "thread-1",
  projectId: "project-1",
  workId: "work-1",
  parentThreadId: null,
  title: "River",
  kind: "primary" as const,
  attention: "actionRequired" as const,
  runningTurnId: null,
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [thread], isError: false, refetch: vi.fn() }),
}));
vi.mock("@/client/query/useThreadSnapshotSync", () => ({
  useThreadSnapshotSync: () => ({
    thread,
    attention: thread.attention,
    liveState: null,
    nextSeq: "1",
    settled: true,
    isError: false,
    refetch: vi.fn(),
  }),
}));

const projectId = "project-1";
const threadId = "thread-1";
const page: HomeChatFeedPage = {
  featured: {
    continueChat: {
      id: threadId,
      title: "River",
      work: { id: "work-1", title: "First Work" },
      lastMessagePreview: "Keep climbing.",
      lastActivityAt: "2026-08-13T00:00:00.000Z",
      attention: "unread",
      isFavorite: false,
    },
    favoriteChats: [],
  },
  recentChats: { items: [], nextCursor: null },
};
const success = {
  threadId,
  isFavorite: false,
  manuallyUnread: false,
  lastOpenedAt: "2026-08-13T00:01:00.000Z",
  attention: "none" as const,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Patch = { body: unknown; resolve: (response: Response) => void };

function router(feedPage: HomeChatFeedPage = page) {
  const patches: Patch[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/home-feed")) return Promise.resolve(json(feedPage));
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((done) => {
        resolve = done;
      });
      patches.push({ body: JSON.parse(String(init?.body)), resolve });
      return promise;
    }),
  );
  return patches;
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("condition was not reached");
}

const buttonNamed = (name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === name,
  );

async function chooseMarkUnread() {
  const trigger = document.querySelector('[aria-label="Actions for River"]') as HTMLButtonElement;
  await act(async () => {
    const PointerEventConstructor = window.PointerEvent ?? window.MouseEvent;
    trigger.dispatchEvent(
      new PointerEventConstructor("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      } as PointerEventInit),
    );
    trigger.click();
  });
  await waitFor(() => document.body.textContent?.includes("Mark unread") === true);
  const markUnread = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
    item.textContent?.includes("Mark unread"),
  ) as HTMLElement;
  await act(async () => markUnread.click());
}

function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ThreadStoreProvider now={Date.now()}>
          {children}
          <AnnouncementRegion />
        </ThreadStoreProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

function HomeToChatHarness({ client }: { client: QueryClient }) {
  const [chat, setChat] = useState(false);
  const [transfer, setTransfer] = useState<OpenAcknowledgementTransfer>();
  const open = useCallback(
    (id: string) => {
      const offer = prepareHomeOpenAcknowledgement(client, { projectId, threadId: id });
      if (offer.kind === "transfer") setTransfer(offer.transfer);
      setChat(true);
    },
    [client],
  );
  return chat ? (
    <ChatScreen
      projectId={projectId}
      threadId={threadId}
      activeWork={null}
      onSelectThread={vi.fn()}
      visible
      openTransfer={transfer}
      onOpenTransferClaimed={(claimed) => {
        if (claimed === transfer) setTransfer(undefined);
      }}
    />
  ) : (
    <HomeScreen projectId={projectId} onSelectThread={vi.fn()} onOpenThread={open} />
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("visible Chat open caller boundary", () => {
  it.each([
    "success",
    "failure",
  ] as const)("transfers an actual Home opening to actual Chat on %s", async (settlement) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(threadQueryKeys.snapshot(threadId), {
      attention: "unread",
    } as ThreadSnapshotResponse);
    const patches = router();

    await withReactRoot(
      <StrictMode>
        <Providers client={client}>
          <HomeToChatHarness client={client} />
        </Providers>
      </StrictMode>,
      async () => {
        await waitFor(() => Boolean(document.querySelector('[aria-label="Open River"]')));
        await act(async () =>
          (document.querySelector('[aria-label="Open River"]') as HTMLButtonElement).click(),
        );
        expect(document.body.textContent).toContain("Conversation thread-1");
        await waitFor(() => patches.length === 1);
        expect(patches.map((request) => request.body)).toEqual([{ isUnread: false }]);
        patches[0]?.resolve(
          settlement === "success" ? json(success) : json({ message: "offline" }, 503),
        );
        if (settlement === "success") {
          await waitFor(
            () =>
              client.getQueryData<ThreadSnapshotResponse>(threadQueryKeys.snapshot(threadId))
                ?.attention === "none",
          );
          expect(document.body.textContent).not.toContain("couldn’t save");
        } else {
          await waitFor(() => document.body.textContent?.includes("couldn’t save") === true);
          const assertive = Array.from(
            document.querySelectorAll('[role="alert"], [aria-live="assertive"]'),
          ).filter((node) => node.textContent?.trim());
          expect(assertive).toHaveLength(1);
          expect(document.body.textContent).not.toContain("still unread");
          const retry = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Retry",
          );
          await act(async () => retry?.click());
          await waitFor(() => patches.length === 2);
          expect(patches.map((request) => request.body)).toEqual([
            { isUnread: false },
            { isUnread: false },
          ]);
          patches[1]?.resolve(json(success));
          await waitFor(() => !document.body.textContent?.includes("couldn’t save"));
        }
      },
      { drainMacrotask: true },
    );
  });

  it("acknowledges direct action-required entry once per visibility epoch", async () => {
    const client = new QueryClient();
    const patches = router();
    function Harness() {
      const [visible, setVisible] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setVisible((value) => !value)}>
            Toggle chat
          </button>
          <ChatScreen
            projectId={projectId}
            threadId={threadId}
            activeWork={null}
            onSelectThread={vi.fn()}
            visible={visible}
          />
        </>
      );
    }
    await withReactRoot(
      <StrictMode>
        <Providers client={client}>
          <Harness />
        </Providers>
      </StrictMode>,
      async () => {
        await waitFor(() => patches.length === 1);
        patches[0]?.resolve(json({ ...success, attention: "actionRequired" }));
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(patches).toHaveLength(1);
        const toggle = Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Toggle chat"),
        );
        await act(async () => toggle?.click());
        await Promise.resolve();
        await act(async () => toggle?.click());
        await waitFor(() => patches.length === 2);
        expect(patches.map((request) => request.body)).toEqual([
          { isUnread: false },
          { isUnread: false },
        ]);
      },
      { drainMacrotask: true },
    );
  });

  it("keeps a visible key switch from exposing or detaching the prior key's failure", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const patches = router();
    const commits: Array<{ threadId: string; hasFailure: boolean; hasRetry: boolean }> = [];

    function Harness() {
      const [selectedThreadId, setSelectedThreadId] = useState("thread-1");
      useLayoutEffect(() => {
        commits.push({
          threadId: selectedThreadId,
          hasFailure: document.body.textContent?.includes("couldn’t save") === true,
          hasRetry: Array.from(document.querySelectorAll("button")).some(
            (button) => button.textContent?.trim() === "Retry",
          ),
        });
      });
      return (
        <>
          <button type="button" onClick={() => setSelectedThreadId("thread-2")}>
            Switch chat
          </button>
          <ChatScreen
            projectId={projectId}
            threadId={selectedThreadId}
            activeWork={null}
            onSelectThread={vi.fn()}
            visible
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
        patches[0]?.resolve(json({ message: "thread 1 offline" }, 503));
        await waitFor(() => document.body.textContent?.includes("couldn’t save") === true);

        commits.length = 0;
        const switchChat = Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Switch chat"),
        );
        await act(async () => switchChat?.click());
        await waitFor(() => patches.length === 2);

        const threadTwoCommits = commits.filter((commit) => commit.threadId === "thread-2");
        expect(threadTwoCommits.length).toBeGreaterThan(0);
        expect(threadTwoCommits.every((commit) => !commit.hasFailure && !commit.hasRetry)).toBe(
          true,
        );

        patches[1]?.resolve(json({ message: "thread 2 offline" }, 503));
        await waitFor(() => document.body.textContent?.includes("couldn’t save") === true);
        const retry = Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Retry",
        );
        await act(async () => retry?.click());
        await waitFor(() => patches.length === 3);
        expect(patches.map((request) => request.body)).toEqual([
          { isUnread: false },
          { isUnread: false },
          { isUnread: false },
        ]);
        patches[2]?.resolve(json({ ...success, threadId: "thread-2" }));
        await waitFor(() => !document.body.textContent?.includes("couldn’t save"));
      },
      { drainMacrotask: true },
    );
  });

  it("does not let a failed actual Mark unread impersonate the following opening", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const readPage: HomeChatFeedPage = {
      ...page,
      featured: {
        continueChat: { ...page.featured?.continueChat, attention: "none" } as NonNullable<
          HomeChatFeedPage["featured"]
        >["continueChat"],
        favoriteChats: [],
      },
    };
    const patches = router(readPage);
    await withReactRoot(
      <Providers client={client}>
        <HomeToChatHarness client={client} />
      </Providers>,
      async () => {
        await waitFor(() => Boolean(document.querySelector('[aria-label="Actions for River"]')));
        await chooseMarkUnread();
        await waitFor(() => patches.length === 1);
        expect(patches[0]?.body).toEqual({ isUnread: true });
        patches[0]?.resolve(json({ message: "manual offline" }, 503));
        await waitFor(
          () => document.body.textContent?.includes("Read status wasn’t saved") === true,
        );

        await act(async () =>
          (document.querySelector('[aria-label="Open River"]') as HTMLButtonElement).click(),
        );
        await waitFor(() => patches.length === 2);
        expect(patches.map((request) => request.body)).toEqual([
          { isUnread: true },
          { isUnread: false },
        ]);
        expect(document.body.textContent).not.toContain("couldn’t save that you opened");
        expect(document.body.textContent).not.toContain("still unread");
        patches[1]?.resolve(json(success));
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(document.body.textContent).not.toContain("couldn’t save that you opened");
      },
      { drainMacrotask: true },
    );
  });

  it.each([
    "success",
    "failure",
  ] as const)("queues an actual Home open behind pending Mark unread after first %s", async (settlement) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(threadQueryKeys.snapshot(threadId), {
      attention: "none",
    } as ThreadSnapshotResponse);
    const readPage: HomeChatFeedPage = {
      ...page,
      featured: {
        continueChat: { ...page.featured?.continueChat, attention: "none" } as NonNullable<
          HomeChatFeedPage["featured"]
        >["continueChat"],
        favoriteChats: [],
      },
    };
    const patches = router(readPage);

    await withReactRoot(
      <Providers client={client}>
        <HomeToChatHarness client={client} />
      </Providers>,
      async () => {
        await waitFor(() => Boolean(document.querySelector('[aria-label="Actions for River"]')));
        await chooseMarkUnread();
        await waitFor(() => patches.length === 1);
        expect(patches[0]?.body).toEqual({ isUnread: true });

        await act(async () =>
          (document.querySelector('[aria-label="Open River"]') as HTMLButtonElement).click(),
        );
        expect(document.body.textContent).toContain("Conversation thread-1");
        expect(patches).toHaveLength(1);

        patches[0]?.resolve(
          settlement === "success"
            ? json({ ...success, manuallyUnread: true, attention: "unread" })
            : json({ message: "manual offline" }, 503),
        );
        await waitFor(() => patches.length === 2);
        expect(patches.map((request) => request.body)).toEqual([
          { isUnread: true },
          { isUnread: false },
        ]);
        expect(document.body.textContent).not.toContain("couldn’t save that you opened");

        patches[1]?.resolve(json(success));
        await waitFor(
          () =>
            client.getQueryData<ThreadSnapshotResponse>(threadQueryKeys.snapshot(threadId))
              ?.attention === "none",
        );
        expect(document.body.textContent).not.toContain("couldn’t save that you opened");
      },
      { drainMacrotask: true },
    );
  });

  it.each([
    "success",
    "failure",
  ] as const)("queues one Home Mark unread behind the visible Chat's initial open %s", async (settlement) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(threadQueryKeys.snapshot(threadId), {
      attention: "unread",
    } as ThreadSnapshotResponse);
    const patches = router();
    useDockViewStore.getState().setDockView("home", "chat");

    await withReactRoot(
      <Providers client={client}>
        <HomeScreen projectId={projectId} onSelectThread={vi.fn()} onOpenThread={vi.fn()} />
        <ChatSurface
          projectId={projectId}
          threadId={threadId}
          activeWork={null}
          activeScreen="home"
          onSelectThread={vi.fn()}
          placement="dock"
          visible
        />
      </Providers>,
      async () => {
        await waitFor(() => patches.length === 1);
        expect(patches[0]?.body).toEqual({ isUnread: false });
        await waitFor(() => Boolean(document.querySelector('[aria-label="Actions for River"]')));
        await chooseMarkUnread();
        await chooseMarkUnread();
        expect(patches).toHaveLength(1);

        patches[0]?.resolve(
          settlement === "success" ? json(success) : json({ message: "open offline" }, 503),
        );
        await waitFor(() => patches.length === 2);
        expect(patches.map((request) => request.body)).toEqual([
          { isUnread: false },
          { isUnread: true },
        ]);
        if (settlement === "failure") {
          await waitFor(
            () => document.body.textContent?.includes("couldn’t save that you opened") === true,
          );
        }

        patches[1]?.resolve(json({ ...success, manuallyUnread: true, attention: "unread" }));
        await waitFor(
          () =>
            groupHomeFeed(client.getQueryData(projectQueryKeys.homeFeed(projectId))).continueChat
              ?.attention === "unread",
        );
        expect(patches).toHaveLength(2);
        if (settlement === "failure") {
          expect(document.body.textContent).toContain("couldn’t save that you opened");
        }
      },
      { drainMacrotask: true },
    );
  });

  it("uses final DockShell visibility and preserves the same lease when Chat moves to center", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(threadQueryKeys.snapshot(threadId), {
      attention: "unread",
    } as ThreadSnapshotResponse);
    const patches = router();
    useDockViewStore.getState().setDockView("home", "changes");

    function Harness() {
      const [placement, setPlacement] = useState<"dock" | "center">("dock");
      return (
        <>
          <button type="button" onClick={() => setPlacement("center")}>
            Move to center
          </button>
          <ChatSurface
            projectId={projectId}
            threadId={threadId}
            activeWork={null}
            activeScreen="home"
            onSelectThread={vi.fn()}
            placement={placement}
            visible
          />
        </>
      );
    }

    await withReactRoot(
      <StrictMode>
        <Providers client={client}>
          <Harness />
        </Providers>
      </StrictMode>,
      async () => {
        await waitFor(() => document.body.textContent?.includes("Pending changes") === true);
        expect(patches).toHaveLength(0);

        await act(async () => buttonNamed("Chat")?.click());
        await waitFor(() => patches.length === 1);
        expect(patches[0]?.body).toEqual({ isUnread: false });
        patches[0]?.resolve(json(success));
        await waitFor(
          () =>
            client.getQueryData<ThreadSnapshotResponse>(threadQueryKeys.snapshot(threadId))
              ?.attention === "none",
        );

        await act(async () => buttonNamed("Move to center")?.click());
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(patches).toHaveLength(1);
      },
      { drainMacrotask: true },
    );
  });

  it("routes an actual Home first send without preparing an existing-chat open transfer", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const selects: string[] = [];
    const cardOpens: string[] = [];
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path, method, body });
        if (path.includes("/home-feed")) return Promise.resolve(json(page));
        if (path.includes(`/api/projects/${projectId}/works`)) {
          return Promise.resolve(
            json({
              newChatFallbackWorkId: "work-1",
              works: [{ id: "work-1", projectId, name: "Book 1", aiWriteMode: "draft" }],
            }),
          );
        }
        if (path === `/api/projects/${projectId}/threads` && method === "POST") {
          return Promise.resolve(
            json({
              id: body && typeof body === "object" && "id" in body ? body.id : "thread-new",
              projectId,
              workId: "work-1",
              currentAgent: null,
              title: "Opening line",
              kind: "primary",
              status: "idle",
              activeLeafTurnId: null,
              parentThreadId: null,
              createdAt: "2026-08-14T00:00:00.000Z",
              updatedAt: "2026-08-14T00:00:00.000Z",
            }),
          );
        }
        throw new Error(`unexpected request: ${method} ${path}`);
      }),
    );

    await withReactRoot(
      <Providers client={client}>
        <HomeScreen
          projectId={projectId}
          onSelectThread={async (id) => {
            selects.push(id);
          }}
          onOpenThread={(id) => cardOpens.push(id)}
        />
      </Providers>,
      async () => {
        await waitFor(() => Boolean(document.querySelector('textarea[aria-label="Message"]')));
        const textarea = document.querySelector(
          'textarea[aria-label="Message"]',
        ) as HTMLTextAreaElement;
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )?.set;
          setter?.call(textarea, "Opening line");
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await waitFor(
          () => !(buttonNamed("Send message") as HTMLButtonElement | undefined)?.disabled,
        );
        await act(async () => {
          textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        expect(
          requests.filter(
            (request) =>
              request.path === `/api/projects/${projectId}/threads` && request.method === "POST",
          ),
        ).toHaveLength(1);
        expect(cardOpens).toEqual([]);
        await waitFor(() => selects.length === 1);

        const create = requests.find(
          (request) => request.path === `/api/projects/${projectId}/threads`,
        );
        expect(create?.body).toMatchObject({ title: "Opening line" });
        expect(create?.body).toHaveProperty("id");
        expect(Object.hasOwn(create?.body as object, "workId")).toBe(false);
        expect(selects).toHaveLength(1);
        expect(cardOpens).toEqual([]);
        expect(requests.filter((request) => request.path.includes("/user-state"))).toEqual([]);
      },
      { drainMacrotask: true },
    );
  });
});
