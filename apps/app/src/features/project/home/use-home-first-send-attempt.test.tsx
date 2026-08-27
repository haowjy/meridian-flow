// @vitest-environment jsdom
/** Exhaustive Home first-send lifecycle contracts. */
import { meridianErrorFromSystem, type Thread } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError, MeridianApiError } from "@/client/api/http-client";
import type { ThreadStoreActions } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useHomeFirstSendAttempt } from "./use-home-first-send-attempt";

vi.mock("@lingui/core/macro", () => ({ msg: (parts: TemplateStringsArray) => parts.join("") }));

const canonical = (overrides: Partial<Thread> = {}): Thread => ({
  id: "thread-1",
  projectId: "project-1",
  workId: "work-1",
  userId: "user-1",
  kind: "primary",
  status: "idle",
  title: "Opening line",
  slug: null,
  currentAgent: null,
  activeLeafTurnId: null,
  parentThreadId: null,
  rootThreadId: "thread-1",
  spawnDepth: 0,
  spawnStatus: null,
  totalCostUsd: "0",
  turnCount: 0,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

function threadActions() {
  return {
    ensureThread: vi.fn(),
    appendUserTurn: vi.fn(() => ({ id: "turn-local" })),
    stageFirstSend: vi.fn(),
    preserveFirstSendRouteDraft: vi.fn(),
    armFirstSend: vi.fn(),
  } as unknown as ThreadStoreActions;
}

function refusal(code: "agent_not_found" | "work_unavailable") {
  return new MeridianApiError(meridianErrorFromSystem(code, code), 400);
}

afterEach(() => vi.restoreAllMocks());

describe("useHomeFirstSendAttempt lifecycle", () => {
  it.each([
    "agent_not_found",
    "work_unavailable",
  ] as const)("only %s unlocks immutable context repair", async (code) => {
    const actions = threadActions();
    const createThread = vi
      .fn()
      .mockRejectedValueOnce(refusal(code))
      .mockResolvedValueOnce(canonical());
    let controller!: ReturnType<typeof useHomeFirstSendAttempt>;
    function Harness() {
      controller = useHomeFirstSendAttempt({
        projectId: "project-1",
        actions,
        onSelectThread: vi.fn(async () => undefined),
        createThread,
        listThreads: vi.fn(),
        makeId: () => "thread-1",
      });
      return null;
    }

    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await act(async () => {
          await expect(
            controller.submit("Exact opening", { workId: "stale", agentSlug: "general" }, 0),
          ).resolves.toBe(false);
        });
        expect(controller.state).toMatchObject({ kind: "refused", refusal: code });
        expect(controller.contextLocked).toBe(false);

        await act(async () => {
          await expect(controller.retry({ workId: "work-1", agentSlug: "general" })).resolves.toBe(
            true,
          );
        });
        expect(createThread).toHaveBeenNthCalledWith(
          2,
          "project-1",
          expect.objectContaining({ id: "thread-1", title: "Exact opening", workId: "work-1" }),
        );
        expect(actions.stageFirstSend).toHaveBeenCalledOnce();
      },
    );
  });

  it("keeps a 5xx ambiguity on the original ID and envelope until reconciliation succeeds", async () => {
    const actions = threadActions();
    const createThread = vi
      .fn()
      .mockRejectedValue(new HttpResponseError("server error", 500, null));
    const listThreads = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce([canonical()]);
    const onSelectThread = vi.fn(async () => undefined);
    let controller!: ReturnType<typeof useHomeFirstSendAttempt>;
    function Harness() {
      controller = useHomeFirstSendAttempt({
        projectId: "project-1",
        actions,
        onSelectThread,
        createThread,
        listThreads,
        makeId: () => "thread-1",
      });
      return null;
    }

    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await act(async () => {
          await expect(
            controller.submit("Exact opening", { workId: "work-1", agentSlug: "general" }, 0),
          ).resolves.toBe(false);
        });
        expect(controller.state).toMatchObject({
          kind: "ambiguous",
          envelope: { threadId: "thread-1", workId: "work-1", agentSlug: "general" },
        });
        expect(controller.contextLocked).toBe(true);
        expect(createThread).toHaveBeenCalledTimes(2);
        expect(createThread.mock.calls[0]?.[1]).toEqual(createThread.mock.calls[1]?.[1]);

        await act(async () => {
          await expect(
            controller.retry({ workId: "different-work", agentSlug: "different-agent" }),
          ).resolves.toBe(true);
        });
        expect(createThread).toHaveBeenCalledTimes(2);
        expect(onSelectThread).toHaveBeenCalledWith("thread-1");
      },
    );
  });

  it("retires a mismatch without staging it and starts the next submission with a fresh ID", async () => {
    const actions = threadActions();
    const ids = ["thread-1", "thread-2"];
    const createThread = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection closed"))
      .mockResolvedValueOnce(canonical({ id: "thread-2", rootThreadId: "thread-2" }));
    const listThreads = vi
      .fn()
      .mockResolvedValue([canonical({ workId: "other-work", currentAgent: "other-agent" })]);
    const onSelectThread = vi.fn(async () => undefined);
    let controller!: ReturnType<typeof useHomeFirstSendAttempt>;
    function Harness() {
      controller = useHomeFirstSendAttempt({
        projectId: "project-1",
        actions,
        onSelectThread,
        createThread,
        listThreads,
        makeId: () => ids.shift() ?? "unexpected",
      });
      return null;
    }

    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await act(async () => {
          await controller.submit("Opening", { workId: "work-1", agentSlug: "general" }, 0);
        });
        expect(controller.state.kind).toBe("mismatched");
        expect(actions.stageFirstSend).not.toHaveBeenCalled();
        expect(onSelectThread).not.toHaveBeenCalled();

        act(() => expect(controller.startOver()).toBe(true));
        expect(controller.state.kind).toBe("idle");
        await act(async () => {
          await controller.submit("Opening", { workId: "work-1", agentSlug: "general" }, 0);
        });
        expect(createThread).toHaveBeenLastCalledWith(
          "project-1",
          expect.objectContaining({ id: "thread-2" }),
        );
        expect(onSelectThread).toHaveBeenCalledWith("thread-2");
      },
    );
  });

  it("retries only routing and transfers a newer draft after canonical creation", async () => {
    const actions = threadActions();
    const createThread = vi.fn().mockResolvedValue(canonical());
    const onSelectThread = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("route failed"))
      .mockResolvedValueOnce(undefined);
    let controller!: ReturnType<typeof useHomeFirstSendAttempt>;
    function Harness() {
      controller = useHomeFirstSendAttempt({
        projectId: "project-1",
        actions,
        onSelectThread,
        createThread,
        listThreads: vi.fn(),
        makeId: () => "thread-1",
      });
      return null;
    }

    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await act(async () => {
          await controller.submit("Opening", { workId: "work-1", agentSlug: "general" }, 0);
        });
        expect(controller.state.kind).toBe("route_failed");
        expect(controller.contextLocked).toBe(true);
        act(() => controller.updateDraft("Follow-up", 1));
        await act(async () => {
          await controller.retry({ workId: "ignored", agentSlug: "ignored" });
        });
        expect(createThread).toHaveBeenCalledOnce();
        expect(actions.preserveFirstSendRouteDraft).toHaveBeenCalledWith("thread-1", "Follow-up");
        expect(onSelectThread).toHaveBeenCalledTimes(2);
      },
    );
  });
});
