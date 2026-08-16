// @vitest-environment jsdom
/** Rendered Home first-send contracts across the shared Composer and destination claimant. */
import { I18nProvider } from "@lingui/react";
import type { ProjectAgentSummary } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useCallback, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import { useThreadOpenAcknowledgement } from "@/client/query/useThreadOpenAcknowledgement";
import { ThreadStoreProvider, useThreadActions } from "@/client/stores";
import { Composer, type ComposerHandle } from "@/components/app/composer";
import { setTestToolbarInlineIds } from "@/components/app/composer-toolbar/composer-toolbar-test-harness";
import { OpenAcknowledgementError } from "@/features/chat/OpenAcknowledgementError";
import { useThreadHandoff } from "@/features/chat/useThreadHandoff";
import { i18n } from "@/lib/i18n";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { HomeScreen } from "./HomeScreen";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => parts.join(""),
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@/components/app/composer/placeholders", () => ({
  useComposerPlaceholder: () => "Write",
}));
vi.mock("@/components/app/composer-toolbar/useMeasuredComposerToolbar", async () => ({
  useMeasuredComposerToolbar: (
    await import("@/components/app/composer-toolbar/composer-toolbar-test-harness")
  ).useTestMeasuredComposerToolbar,
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({ groups: [] }),
}));
vi.mock("@/features/project/dock/useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft: vi.fn() }),
}));

const projectId = "project-1";
const work = (id: string, name: string): Work => ({
  id,
  projectId,
  createdByUserId: "user-1",
  name,
  slug: name.toLowerCase().replaceAll(" ", "-"),
  description: null,
  goal: null,
  status: "active",
  aiWriteMode: "draft",
  archivedAt: null,
  lastActivityAt: "2026-08-14T00:00:00.000Z",
  deletedAt: null,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
});
const firstWork = work("work-1", "Book 1");
const secondWork = work("work-2", "Expedition");
const agents: ProjectAgentSummary[] = [
  {
    slug: "general",
    name: "General",
    description: "General fiction support",
    source: "builtin",
    packageName: null,
  },
  {
    slug: "prose",
    name: "Prose",
    description: "Line-level prose",
    source: "user",
    packageName: null,
  },
];
const homeFeed = {
  featured: { continueChat: null, favoriteChats: [] },
  recentChats: { items: [], nextCursor: null },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const canonical = (id: string, workId: string, currentAgent: string | null = null): Thread => ({
  id,
  projectId,
  workId,
  userId: "user-1",
  kind: "primary",
  status: "idle",
  title: "Opening line",
  slug: null,
  currentAgent,
  activeLeafTurnId: null,
  parentThreadId: null,
  rootThreadId: id,
  spawnDepth: 0,
  spawnStatus: null,
  totalCostUsd: "0",
  turnCount: 0,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  deletedAt: null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("condition not reached");
}

async function setTextarea(text: string) {
  const textarea = document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      text,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

function Destination({
  threadId,
  submit,
}: {
  threadId: string;
  submit: ThreadRunController["submit"];
}) {
  const actions = useThreadActions();
  const composerRef = useRef<ComposerHandle>(null);
  const restore = useCallback(
    (draft: Parameters<ComposerHandle["restoreDraft"]>[0]) =>
      composerRef.current?.restoreDraft(draft) ?? false,
    [],
  );
  const controller = useRef({ submit, resume: vi.fn() } as unknown as ThreadRunController).current;
  useThreadHandoff(threadId, controller, actions, undefined, restore);
  const acknowledgement = useThreadOpenAcknowledgement({ threadId, projectId, visible: true });
  return (
    <>
      <OpenAcknowledgementError error={acknowledgement.error} onRetry={acknowledgement.retry} />
      <Composer ref={composerRef} variant="pinned" onSubmit={() => true} />
    </>
  );
}

function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ThreadStoreProvider now={0}>{children}</ThreadStoreProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

afterEach(() => {
  setTestToolbarInlineIds("all");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Home first send", () => {
  it("transfers an equal-text draft authored after submit while admitting the first message once", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const creation = deferred<Response>();
    const navigation = deferred<void>();
    const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
    const admitted = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : undefined;
        requests.push({ path, method, body });
        if (path.includes("/home-feed")) return Promise.resolve(json(homeFeed));
        if (path.includes("/drafts")) return Promise.resolve(json({ drafts: [] }));
        if (path.includes("/works")) return Promise.resolve(json({ works: [firstWork] }));
        if (path.includes("/agents")) return Promise.resolve(json({ agents }));
        if (method === "POST" && path.endsWith("/threads")) return creation.promise;
        throw new Error(`unexpected request: ${method} ${path}`);
      }),
    );

    function Harness() {
      const [threadId, setThreadId] = useState<string | null>(null);
      return threadId ? (
        <Destination threadId={threadId} submit={admitted} />
      ) : (
        <HomeScreen
          projectId={projectId}
          onOpenThread={vi.fn()}
          onSelectThread={async (id) => {
            await navigation.promise;
            setThreadId(id);
          }}
        />
      );
    }

    await withReactRoot(
      <Providers client={client}>
        <Harness />
      </Providers>,
      async () => {
        await waitFor(() => Boolean(document.querySelector('textarea[aria-label="Message"]')));
        const textarea = await setTextarea("Same words");
        await act(async () =>
          textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
        );
        await waitFor(() => requests.some(({ method }) => method === "POST"));
        await setTextarea("Different interim words");
        await setTextarea("Same words");
        const body = requests.find(({ method }) => method === "POST")?.body;
        await act(async () => creation.resolve(json(canonical(String(body?.id), firstWork.id))));
        await act(async () => navigation.resolve());

        await waitFor(() => admitted.mock.calls.length === 1);
        expect(admitted).toHaveBeenCalledWith(
          String(body?.id),
          "Same words",
          expect.objectContaining({ optimisticUserTurnId: expect.any(String) }),
        );
        expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
          "Same words",
        );
      },
      { drainMacrotask: true },
    );
  });

  it("transfers a newer in-flight draft and admits once without an open acknowledgement", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const creation = deferred<Response>();
    const navigation = deferred<void>();
    const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
    const admitted = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : undefined;
        requests.push({ path, method, body });
        if (path.includes("/home-feed")) return Promise.resolve(json(homeFeed));
        if (path.includes("/drafts")) return Promise.resolve(json({ drafts: [] }));
        if (path.includes("/works")) return Promise.resolve(json({ works: [firstWork] }));
        if (path.includes("/agents")) return Promise.resolve(json({ agents }));
        if (method === "POST" && path.endsWith("/threads")) return creation.promise;
        throw new Error(`unexpected request: ${method} ${path}`);
      }),
    );

    function Harness() {
      const [threadId, setThreadId] = useState<string | null>(null);
      return threadId ? (
        <Destination threadId={threadId} submit={admitted} />
      ) : (
        <HomeScreen
          projectId={projectId}
          onOpenThread={vi.fn()}
          onSelectThread={async (id) => {
            await navigation.promise;
            setThreadId(id);
          }}
        />
      );
    }

    await withReactRoot(
      <Providers client={client}>
        <Harness />
      </Providers>,
      async () => {
        await waitFor(() => Boolean(document.querySelector('textarea[aria-label="Message"]')));
        const textarea = await setTextarea("Immutable first message");
        await act(async () =>
          textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
        );
        await waitFor(() => requests.some(({ method }) => method === "POST"));
        await setTextarea("Draft typed during create");
        const body = requests.find(({ method }) => method === "POST")?.body;
        await act(async () => creation.resolve(json(canonical(String(body?.id), firstWork.id))));
        await setTextarea("Newest draft typed during route");
        await act(async () => navigation.resolve());

        await waitFor(() => admitted.mock.calls.length === 1);
        expect(admitted).toHaveBeenCalledWith(
          String(body?.id),
          "Immutable first message",
          expect.objectContaining({ optimisticUserTurnId: expect.any(String) }),
        );
        expect(requests.filter(({ path }) => path.includes("/user-state"))).toHaveLength(0);
        expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
          "Newest draft typed during route",
        );
        expect(document.body.textContent).not.toContain("couldn’t save that you opened");
      },
      { drainMacrotask: true },
    );
  });

  it("repairs a stale Work through the real picker and retries the same ID and text", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let worksReads = 0;
    const creates: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        const method = init?.method ?? "GET";
        if (path.includes("/home-feed")) return Promise.resolve(json(homeFeed));
        if (path.includes("/drafts")) return Promise.resolve(json({ drafts: [] }));
        if (path.includes("/works")) {
          worksReads += 1;
          return Promise.resolve(
            json({
              works: worksReads === 1 ? [firstWork, secondWork] : [firstWork],
            }),
          );
        }
        if (path.includes("/agents")) return Promise.resolve(json({ agents }));
        if (method === "POST" && path.endsWith("/threads")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          creates.push(body);
          return Promise.resolve(
            creates.length === 1
              ? json({ message: "Work is not available in this project" }, 400)
              : json(canonical(String(body.id), firstWork.id)),
          );
        }
        throw new Error(`unexpected request: ${method} ${path}`);
      }),
    );

    await withReactRoot(
      <Providers client={client}>
        <HomeScreen
          projectId={projectId}
          onOpenThread={vi.fn()}
          onSelectThread={async () => undefined}
        />
      </Providers>,
      async () => {
        await waitFor(() => Boolean(document.querySelector('[aria-label*="currently Book 1"]')));
        await act(async () =>
          document.querySelector<HTMLButtonElement>('[aria-label*="currently Book 1"]')?.click(),
        );
        await waitFor(() => document.body.textContent?.includes("Expedition") === true);
        await act(async () =>
          [...document.querySelectorAll("button")]
            .find(({ textContent }) => textContent?.trim() === "Expedition")
            ?.click(),
        );
        const textarea = await setTextarea("Exact opening line");
        await act(async () =>
          textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
        );
        await waitFor(() => document.body.textContent?.includes("Chat couldn’t start") === true);
        const send = document.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
        expect(send?.disabled).toBe(true);
        expect(worksReads).toBeGreaterThanOrEqual(2);

        await act(async () =>
          document.querySelector<HTMLButtonElement>('[aria-label*="choice unavailable"]')?.click(),
        );
        await waitFor(() => document.body.textContent?.includes("Book 1") === true);
        await act(async () =>
          [...document.querySelectorAll("button")]
            .find(({ textContent }) => textContent?.trim() === "Book 1")
            ?.click(),
        );
        await act(async () =>
          [...document.querySelectorAll("button")]
            .find(({ textContent }) => textContent?.trim() === "Retry")
            ?.click(),
        );
        await waitFor(() => creates.length === 2);
        expect(creates[0]).toMatchObject({ workId: secondWork.id, title: "Exact opening line" });
        expect(creates[1]).toMatchObject({ workId: firstWork.id, title: "Exact opening line" });
        expect(creates[1]?.id).toBe(creates[0]?.id);
      },
      { drainMacrotask: true },
    );
  });

  it("shows an authoritative empty catalog instead of perpetual loading", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const path = String(input);
        if (path.includes("/home-feed")) return Promise.resolve(json(homeFeed));
        if (path.includes("/drafts")) return Promise.resolve(json({ drafts: [] }));
        if (path.includes("/works")) return Promise.resolve(json({ works: [] }));
        if (path.includes("/agents")) return Promise.resolve(json({ agents }));
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    await withReactRoot(
      <Providers client={client}>
        <HomeScreen projectId={projectId} onOpenThread={vi.fn()} onSelectThread={vi.fn()} />
      </Providers>,
      async () => {
        await waitFor(() => document.body.textContent?.includes("No Work yet.") === true);
        expect(document.body.textContent).not.toContain("Loading Work");
        expect(
          document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled,
        ).toBe(true);
      },
      { drainMacrotask: true },
    );
  });

  it("submits the first archived Work when the catalog has no active Work", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const archivedWork = { ...firstWork, status: "archived" as const };
    const creates: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        const method = init?.method ?? "GET";
        if (path.includes("/home-feed")) return Promise.resolve(json(homeFeed));
        if (path.includes("/drafts")) return Promise.resolve(json({ drafts: [] }));
        if (path.includes("/works")) return Promise.resolve(json({ works: [archivedWork] }));
        if (path.includes("/agents")) return Promise.resolve(json({ agents }));
        if (method === "POST" && path.endsWith("/threads")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          creates.push(body);
          return Promise.resolve(json(canonical(String(body.id), archivedWork.id)));
        }
        throw new Error(`unexpected request: ${method} ${path}`);
      }),
    );

    await withReactRoot(
      <Providers client={client}>
        <HomeScreen projectId={projectId} onOpenThread={vi.fn()} onSelectThread={vi.fn()} />
      </Providers>,
      async () => {
        await waitFor(() => Boolean(document.querySelector('[aria-label*="currently Book 1"]')));
        const textarea = await setTextarea("Archived opening");
        await act(async () =>
          textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
        );
        await waitFor(() => creates.length === 1);
        expect(creates[0]).toMatchObject({ workId: archivedWork.id });
      },
      { drainMacrotask: true },
    );
  });
});
