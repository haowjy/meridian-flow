// @vitest-environment jsdom
/** The real provider replays controller ownership without publishing a dead context value. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";
import type { ThreadTransport, ThreadTransportHandlers } from "@/core/transport";
import { MeridianCopilotProvider, useMeridianAgent } from "./MeridianCopilotProvider";
import type { ThreadRunController } from "./ThreadRunController";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  actions: null as ReturnType<ReturnType<typeof createThreadStore>["getState"]> | null,
  transport: null as ThreadTransport | null,
  signal: null as AbortSignal | null,
  append: vi.fn(),
}));
vi.mock("@/client/stores", () => ({ useThreadActions: () => harness.actions }));
vi.mock("@/client/providers/TransportProvider", () => ({
  useThreadTransport: () => harness.transport,
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountId: () => "account-1",
  useOptionalAccountEpochSignal: () => harness.signal,
}));
vi.mock("@/client/api/threads-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/threads-api")>()),
  appendUserMessage: (args: unknown) => harness.append(args),
}));

const dispose: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of dispose.splice(0)) await cleanup();
});

it("publishes a usable controller after StrictMode replay and fences retired transport callbacks", async () => {
  const account = new AbortController();
  harness.signal = account.signal;
  const store = createThreadStore({
    now: 0,
    threadCache: {
      upsertThread() {},
      patchThread() {},
      invalidateThread() {},
      invalidateThreadSnapshot() {},
    },
  });
  const markAmbiguous = vi.spyOn(store.getState(), "markInterruptResponsesForGenerationAmbiguous");
  harness.actions = store.getState();
  const runs: Array<{ handlers: ThreadTransportHandlers; active: boolean }> = [];
  const closed: Array<{ callback: (generation: number) => void; active: boolean }> = [];
  const errors: Array<{
    callback: (event: { threadId: string; error: Error }) => void;
    active: boolean;
  }> = [];
  harness.transport = {
    subscribe(_threadId: string, handlers: ThreadTransportHandlers) {
      const row = { handlers, active: true };
      runs.push(row);
      return () => {
        row.active = false;
      };
    },
    onSocketGenerationClosed(callback: (generation: number) => void) {
      const row = { callback, active: true };
      closed.push(row);
      return () => {
        row.active = false;
      };
    },
    onInterruptResponseError(callback: (event: { threadId: string; error: Error }) => void) {
      const row = { callback, active: true };
      errors.push(row);
      return () => {
        row.active = false;
      };
    },
  } as ThreadTransport;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  const controller = { current: null as ThreadRunController | null };
  function Capture() {
    controller.current = useMeridianAgent();
    return null;
  }
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <MeridianCopilotProvider>
            <Capture />
          </MeridianCopilotProvider>
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
  dispose.push(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });
  expect(closed.filter((row) => row.active)).toHaveLength(1);
  expect(closed).toHaveLength(2);
  expect(errors.filter((row) => row.active)).toHaveLength(1);
  controller.current?.resume("thread-1");
  expect(runs.filter((row) => row.active)).toHaveLength(1);
  harness.append.mockResolvedValueOnce({
    threadId: "thread-1",
    userTurnId: "user-1",
    assistantTurnId: "run-2",
    resumeAfterSeq: "42",
    snapshotFloorNextSeq: "43",
    status: "accepted",
  });
  await expect(
    controller.current?.submit("thread-1", {
      submissionId: "sub-1",
      acceptedRevision: 0,
      text: "hello",
      blocks: [],
      references: [],
      activatedSkillSlugs: [],
    }),
  ).resolves.toMatchObject({ kind: "accepted" });
  expect(runs.filter((row) => row.active)).toHaveLength(1);
  closed[0]?.callback(1);
  expect(markAmbiguous).not.toHaveBeenCalled();
  account.abort();
  closed.at(-1)?.callback(1);
  expect(markAmbiguous).not.toHaveBeenCalled();
  harness.signal = new AbortController().signal;
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <MeridianCopilotProvider>
            <Capture />
          </MeridianCopilotProvider>
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
  controller.current?.resume("thread-1");
  const savedRun = runs.at(-1)?.handlers.onEvent;
  await act(async () => root.unmount());
  savedRun?.({
    seq: "1000",
    event: { type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" } as never,
  });
  controller.current?.resume("thread-1");
  expect(runs.filter((row) => row.active)).toHaveLength(0);
  expect((store.getState().turns("thread-1") ?? []).some((turn) => turn.id === "run-1")).toBe(
    false,
  );
});
