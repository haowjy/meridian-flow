// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const createProjectThread = vi.fn();
const invalidateProjectThreadData = vi.fn();

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/client/api/projects-api", () => ({ createProjectThread }));
vi.mock("@/client/query/project-invalidation", () => ({ invalidateProjectThreadData }));
vi.mock("./chats-overview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chats-overview")>()),
  useChatsOverview: () => ({ rows: [], workCount: 0, loaded: true }),
}));
vi.mock("./WorksManager", () => ({ WorksManager: () => null }));

const { HomeOverviewBody } = await import("./HomeScreen");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function buttonNamed(name: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === name,
  );
}

afterEach(() => {
  createProjectThread.mockReset();
  invalidateProjectThreadData.mockReset();
});

describe("Home New chat", () => {
  it("shows the pending, failure, retry, and success lifecycle at the invoking surface", async () => {
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
          <HomeOverviewBody projectId="project-1" onSelectThread={onSelectThread}>
            {() => null}
          </HomeOverviewBody>
        </QueryClientProvider>,
        async () => {
          expect(document.body.textContent).not.toContain("Could not create chat");
          expect(buttonNamed("Retry")).toBeUndefined();

          await act(async () => {
            buttonNamed("New chat")?.click();
            await vi.waitFor(() => {
              expect(createProjectThread).toHaveBeenCalledTimes(1);
              expect(buttonNamed("New chat")?.disabled).toBe(true);
            });
          });
          expect(document.body.textContent).not.toContain("Could not create chat");
          expect(buttonNamed("Retry")).toBeUndefined();
          expect(onSelectThread).not.toHaveBeenCalled();

          await act(async () => {
            firstCreate.reject(new Error("Could not create chat"));
            await vi.waitFor(() => {
              expect(buttonNamed("New chat")?.disabled).toBe(false);
              expect(document.body.textContent).toContain("Could not create chat");
              expect(buttonNamed("Retry")).toBeDefined();
            });
          });
          expect(onSelectThread).not.toHaveBeenCalled();

          await act(async () => {
            buttonNamed("Retry")?.click();
            await vi.waitFor(() => {
              expect(createProjectThread).toHaveBeenCalledTimes(2);
              expect(buttonNamed("New chat")?.disabled).toBe(true);
            });
          });
          expect(onSelectThread).not.toHaveBeenCalled();

          await act(async () => {
            retryCreate.resolve({ id: "thread-1" });
            await vi.waitFor(() => {
              expect(onSelectThread).toHaveBeenCalledOnce();
              expect(onSelectThread).toHaveBeenCalledWith("thread-1");
              expect(document.body.textContent).not.toContain("Could not create chat");
            });
          });
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
  });
});
