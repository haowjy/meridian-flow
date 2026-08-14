// @vitest-environment jsdom
/** Integration contracts for Home's stable-ID create and route controller. */
import type { Thread } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadStoreActions } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useHomeFirstSendAttempt } from "./use-home-first-send-attempt";

vi.mock("@lingui/core/macro", () => ({ msg: (parts: TemplateStringsArray) => parts.join("") }));

const canonical = (overrides: Partial<Thread> = {}): Thread => ({
  id: "stable-thread",
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
  rootThreadId: "stable-thread",
  spawnDepth: 0,
  spawnStatus: null,
  totalCostUsd: "0",
  turnCount: 0,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

function actions() {
  return {
    ensureThread: vi.fn(),
    appendUserTurn: vi.fn(() => ({ id: "turn-local" })),
    stageFirstSend: vi.fn(),
    preserveFirstSendRouteDraft: vi.fn(),
    armFirstSend: vi.fn(),
  } as unknown as ThreadStoreActions;
}

afterEach(() => vi.restoreAllMocks());

describe("useHomeFirstSendAttempt", () => {
  it.each([
    {
      name: "current default Work",
      context: {
        work: { source: "current_default", displayedWorkId: "work-1" } as const,
        agentSlug: "general",
      },
      reconciled: canonical({ workId: "work-other" }),
    },
    {
      name: "writer-selected Work",
      context: {
        work: { source: "writer", workId: "work-explicit" } as const,
        agentSlug: "general",
      },
      reconciled: canonical({ workId: "work-other" }),
    },
    {
      name: "non-General Agent",
      context: {
        work: { source: "current_default", displayedWorkId: "work-1" } as const,
        agentSlug: "prose",
      },
      reconciled: canonical({ currentAgent: "other-agent" }),
    },
  ])("quarantines ambiguous reconciliation with mismatched $name", async ({
    context,
    reconciled,
  }) => {
    const threadActions = actions();
    const createThread = vi.fn().mockRejectedValue(new TypeError("connection closed"));
    const listThreads = vi.fn().mockResolvedValue([reconciled]);
    const onSelectThread = vi.fn(async () => undefined);
    let controller!: ReturnType<typeof useHomeFirstSendAttempt>;

    function Harness() {
      controller = useHomeFirstSendAttempt({
        projectId: "project-1",
        actions: threadActions,
        onSelectThread,
        createThread,
        listThreads,
        makeId: () => "stable-thread",
      });
      return null;
    }

    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await act(async () => {
          await expect(controller.submit("Opening line", context)).resolves.toBe(false);
        });
        expect(controller.failure).toBe("mismatch");
        expect(threadActions.appendUserTurn).not.toHaveBeenCalled();
        expect(threadActions.stageFirstSend).not.toHaveBeenCalled();
        expect(onSelectThread).not.toHaveBeenCalled();
        await act(async () => {
          await expect(controller.retry(context)).resolves.toBe(false);
        });
        expect(createThread).toHaveBeenCalledOnce();
        expect(listThreads).toHaveBeenCalledOnce();
      },
    );
  });

  it("reconciles an ambiguous default-Work create by stable ID, then stages and arms once", async () => {
    const threadActions = actions();
    const createThread = vi.fn().mockRejectedValueOnce(new TypeError("connection closed"));
    const listThreads = vi.fn().mockResolvedValue([canonical()]);
    const onSelectThread = vi.fn(async () => undefined);
    let controller!: ReturnType<typeof useHomeFirstSendAttempt>;

    function Harness() {
      controller = useHomeFirstSendAttempt({
        projectId: "project-1",
        actions: threadActions,
        onSelectThread,
        createThread,
        listThreads,
        makeId: () => "stable-thread",
      });
      return null;
    }

    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        let first!: Promise<boolean>;
        let duplicate!: Promise<boolean>;
        await act(async () => {
          first = controller.submit("Opening line", {
            work: { source: "current_default", displayedWorkId: "work-1" },
            agentSlug: "general",
          });
          duplicate = controller.submit("Duplicate", {
            work: { source: "current_default", displayedWorkId: "work-1" },
            agentSlug: "general",
          });
        });
        await expect(duplicate).resolves.toBe(false);
        await expect(first).resolves.toBe(true);

        expect(createThread).toHaveBeenCalledOnce();
        expect(createThread).toHaveBeenCalledWith("project-1", {
          id: "stable-thread",
          title: "Opening line",
        });
        expect(listThreads).toHaveBeenCalledOnce();
        expect(threadActions.appendUserTurn).toHaveBeenCalledOnce();
        expect(threadActions.stageFirstSend).toHaveBeenCalledOnce();
        expect(onSelectThread).toHaveBeenCalledWith("stable-thread");
        expect(threadActions.armFirstSend).toHaveBeenCalledOnce();
      },
    );
  });

  it("keeps an explicit Work immutable and retries only routing while transferring a newer draft", async () => {
    const threadActions = actions();
    const createThread = vi.fn().mockResolvedValue(canonical({ workId: "work-explicit" }));
    const onSelectThread = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("route refused"))
      .mockResolvedValueOnce(undefined);
    let controller!: ReturnType<typeof useHomeFirstSendAttempt>;

    function Harness() {
      controller = useHomeFirstSendAttempt({
        projectId: "project-1",
        actions: threadActions,
        onSelectThread,
        createThread,
        listThreads: vi.fn(),
        makeId: () => "stable-thread",
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
            controller.submit("Opening line", {
              work: { source: "writer", workId: "work-explicit" },
              agentSlug: "general",
            }),
          ).resolves.toBe(false);
        });
        expect(createThread).toHaveBeenCalledWith(
          "project-1",
          expect.objectContaining({ id: "stable-thread", workId: "work-explicit" }),
        );

        await act(async () => {
          controller.updateDraft("A newer follow-up");
          await expect(
            controller.retry({
              work: { source: "writer", workId: "work-explicit" },
              agentSlug: "general",
            }),
          ).resolves.toBe(true);
        });
        expect(createThread).toHaveBeenCalledOnce();
        expect(threadActions.appendUserTurn).toHaveBeenCalledOnce();
        expect(threadActions.stageFirstSend).toHaveBeenCalledOnce();
        expect(threadActions.preserveFirstSendRouteDraft).toHaveBeenCalledWith(
          "stable-thread",
          "A newer follow-up",
        );
        expect(onSelectThread).toHaveBeenCalledTimes(2);
        expect(threadActions.armFirstSend).toHaveBeenCalledOnce();
      },
    );
  });
});
