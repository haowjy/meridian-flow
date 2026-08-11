// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const createProjectThread = vi.fn();
const invalidateProjectThreadData = vi.fn();

vi.mock("@lingui/core/macro", () => ({
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/client/api/projects-api", () => ({ createProjectThread }));
vi.mock("@/client/query/project-invalidation", () => ({ invalidateProjectThreadData }));
vi.mock("@/client/stores", () => ({
  useThreadStore: (selector: (state: { now: number }) => unknown) => selector({ now: 0 }),
}));
vi.mock("@/features/project/data/dashboard-data", () => ({
  useProjectThreadGroups: () => ({
    workItems: [],
    primaryThreads: [],
    threadById: new Map(),
    ungroupedThreads: [],
  }),
}));

const { ThreadSwitcherPopover } = await import("./ThreadSwitcherPopover");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

function buttonNamed(name: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === name,
  );
}

afterEach(() => {
  createProjectThread.mockReset();
  invalidateProjectThreadData.mockReset();
});

describe("thread switcher New chat", () => {
  it("stays expanded through failure and closes and selects only after retry succeeds", async () => {
    const firstCreate = deferred<{ id: string }>();
    const retryCreate = deferred<{ id: string }>();
    createProjectThread
      .mockImplementationOnce(() => firstCreate.promise)
      .mockImplementationOnce(() => retryCreate.promise);
    invalidateProjectThreadData.mockResolvedValue(undefined);
    const onSelectThread = vi.fn();
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <ThreadSwitcherPopover
            projectId="project-1"
            activeThreadId="thread-0"
            title="Existing chat"
            onSelectThread={onSelectThread}
            onRename={vi.fn()}
          />
        </QueryClientProvider>,
        async () => {
          const trigger = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Switch chat, currently Existing chat"]',
          );
          expect(trigger?.getAttribute("aria-expanded")).toBe("false");
          expect(document.body.textContent).not.toContain("Could not create chat");

          act(() => trigger?.click());
          expect(trigger?.getAttribute("aria-expanded")).toBe("true");

          await act(async () => {
            buttonNamed("New chat")?.click();
            await Promise.resolve();
          });
          expect(createProjectThread).toHaveBeenCalledTimes(1);
          expect(buttonNamed("New chat")?.disabled).toBe(true);
          expect(trigger?.getAttribute("aria-expanded")).toBe("true");
          expect(onSelectThread).not.toHaveBeenCalled();

          firstCreate.reject(new Error("Could not create chat"));
          await flush();
          expect(document.body.textContent).toContain("Could not create chat");
          expect(buttonNamed("Retry")).toBeDefined();
          expect(trigger?.getAttribute("aria-expanded")).toBe("true");
          expect(onSelectThread).not.toHaveBeenCalled();

          act(() => buttonNamed("Retry")?.click());
          await flush();
          expect(createProjectThread).toHaveBeenCalledTimes(2);
          expect(buttonNamed("New chat")?.disabled).toBe(true);
          expect(trigger?.getAttribute("aria-expanded")).toBe("true");
          expect(onSelectThread).not.toHaveBeenCalled();

          retryCreate.resolve({ id: "thread-1" });
          await flush();
          expect(onSelectThread).toHaveBeenCalledOnce();
          expect(onSelectThread).toHaveBeenCalledWith("thread-1");
          expect(trigger?.getAttribute("aria-expanded")).toBe("false");
          expect(document.body.textContent).not.toContain("Could not create chat");
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
  });
});
