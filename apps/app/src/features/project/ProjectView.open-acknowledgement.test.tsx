/** ProjectView ownership contracts for Home acknowledgement transfer envelopes. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getOpenAcknowledgementState,
  type OpenAcknowledgementTransfer,
} from "@/client/query/visible-thread-open-acknowledgements";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => parts.join(""),
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ works: [] }),
}));
vi.mock("@/client/stores", () => ({
  useContextTabsStore: (selector: (state: { _deskHydrated: boolean }) => unknown) =>
    selector({ _deskHydrated: true }),
}));
vi.mock("@/client/working-set", () => ({
  hydrateWorkingSet: () => ({ status: "local" }),
  retryWorkingSetHydration: vi.fn(),
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  DraftReviewProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/hooks/use-phone-shell", () => ({ usePhoneShell: () => true }));
vi.mock("./chat/chat-thread-resolution", () => ({
  useResolvedChatThread: (_projectId: string, threadId: string | null) => ({
    resolvedThreadId: threadId,
    projectThreads: [],
  }),
}));
vi.mock("./layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./layout")>();
  return {
    ...actual,
    useProjectSurfacePrefsStore: (selector: (state: { _hydrated: boolean }) => unknown) =>
      selector({ _hydrated: true }),
  };
});
vi.mock("./working-set-tab-seeding", () => ({
  contextDeskReconciliation: () => "local-only",
  seedWorkingSetTabs: vi.fn(),
  validateContextDeskTabs: vi.fn(),
}));

let renderedTransfer: OpenAcknowledgementTransfer | undefined;
vi.mock("./mobile/MobileProject", () => ({
  MobileProject: (props: {
    onOpenThread: (threadId: string) => void;
    openTransfer?: OpenAcknowledgementTransfer;
  }) => {
    renderedTransfer = props.openTransfer;
    return (
      <>
        <button type="button" onClick={() => props.onOpenThread("thread-a")}>
          Open A
        </button>
        <button type="button" onClick={() => props.onOpenThread("thread-b")}>
          Open B
        </button>
      </>
    );
  },
}));

const { ProjectView } = await import("./ProjectView");

type Request = { resolve: (response: Response) => void };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const success = (threadId: string) => ({
  threadId,
  isFavorite: false,
  manuallyUnread: false,
  lastOpenedAt: "2026-08-13T00:01:00.000Z",
  attention: "none" as const,
});
const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

function button(name: string) {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
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

function projectProps(onSelectThread: (threadId: string) => Promise<void>) {
  return {
    projectId: "project-1",
    workingSet: { status: "absent" as const },
    workingSetSyncEnabled: false,
    activeScreen: "home" as const,
    activeThreadId: null,
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
    onSelectContextPath: vi.fn(),
    onOpenResults: vi.fn(),
    onCloseResults: vi.fn(),
  };
}

afterEach(() => {
  renderedTransfer = undefined;
  vi.unstubAllGlobals();
});

describe("ProjectView open acknowledgement ownership", () => {
  it("supersedes the exact prior transfer and ignores its later navigation settlement", async () => {
    const client = new QueryClient();
    const requests: Request[] = [];
    const navigations = new Map<string, ReturnType<typeof deferred<void>>>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        const request = deferred<Response>();
        requests.push({ resolve: request.resolve });
        return request.promise;
      }),
    );

    await withReactRoot(
      <QueryClientProvider client={client}>
        <ProjectView
          {...projectProps((threadId) => {
            const navigation = deferred<void>();
            navigations.set(threadId, navigation);
            return navigation.promise;
          })}
        />
      </QueryClientProvider>,
      async () => {
        await act(async () => button("Open A")?.click());
        const first = renderedTransfer;
        expect(first).toBeDefined();
        await act(async () => button("Open B")?.click());
        const second = renderedTransfer;
        expect(second).toBeDefined();
        expect(second).not.toBe(first);
        if (!first || !second) throw new Error("both transfers must render");
        expect(requests).toHaveLength(2);

        await act(async () => navigations.get("thread-a")?.resolve());
        expect(renderedTransfer).toBe(second);

        requests[0]?.resolve(json(success("thread-a")));
        requests[1]?.resolve(json(success("thread-b")));
        await tick();
        await tick();
        expect(getOpenAcknowledgementState(client, first.id)).toBeNull();
        expect(getOpenAcknowledgementState(client, second.id)).toMatchObject({
          phase: "succeeded",
        });
      },
      { drainMacrotask: true },
    );
  });

  it.each([
    "rejected navigation",
    "settled navigation with a mismatched controlled destination",
  ] as const)("cancels its transfer after %s", async (scenario) => {
    const client = new QueryClient();
    const request = deferred<Response>();
    const navigation = deferred<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => request.promise),
    );

    function Harness() {
      const [activeThreadId] = useState<string | null>(null);
      return (
        <ProjectView {...projectProps(() => navigation.promise)} activeThreadId={activeThreadId} />
      );
    }

    await withReactRoot(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await act(async () => button("Open A")?.click());
        const transfer = renderedTransfer;
        expect(transfer).toBeDefined();
        if (!transfer) throw new Error("transfer must render");

        await act(async () => {
          if (scenario === "rejected navigation") navigation.reject(new Error("blocked"));
          else navigation.resolve();
          await Promise.resolve();
        });
        expect(renderedTransfer).toBeUndefined();

        request.resolve(json({ message: "offline" }, 503));
        await tick();
        expect(getOpenAcknowledgementState(client, transfer.id)).toBeNull();
      },
      { drainMacrotask: true },
    );
  });
});
