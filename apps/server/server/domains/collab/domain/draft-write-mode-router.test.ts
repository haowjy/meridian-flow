/** Unit coverage for response-scoped draft/live write-mode routing edges. */
import type { AgentEditCore, ResponseCommitDestination, WriteCommand } from "@meridian/agent-edit";
import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createDraftSessionFence,
  type DraftSessionFence,
} from "../adapters/drizzle-draft-agent-edit.js";
import { createDraftWriteModeRouter } from "./draft-write-mode-router.js";

const THREAD_ID = "thread-1" as ThreadId;
const THREAD_B_ID = "thread-2" as ThreadId;
const WORK_ID = "work-1" as WorkId;
const TURN_ID = "turn-1" as TurnId;
const DOC_ID = "doc-1";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createCore(overrides: Partial<AgentEditCore> = {}): AgentEditCore {
  return {
    write: vi.fn(async (command: WriteCommand) => ({
      command: command.command,
      status: "success" as const,
      isError: false,
      text: "status: success",
    })),
    recover: vi.fn(async () => {}),
    commitResponse: vi.fn(async (responseId: string) => ({
      responseId,
      documentCount: 0,
      updateCount: 0,
      documents: [],
      stagedCreates: { committed: [], discarded: [] },
    })),
    rollbackResponse: vi.fn(async (responseId: string) => ({
      responseId,
      stagedCreates: { committed: [], discarded: [] },
    })),
    getAvailability: vi.fn(async () => ({ undo: true, redo: true })),
    undo: vi.fn(async () => ({
      command: "undo" as const,
      status: "reversed" as const,
      isError: false,
      text: "status: reversed",
    })),
    redo: vi.fn(async () => ({
      command: "redo" as const,
      status: "reversed" as const,
      isError: false,
      text: "status: reversed",
    })),
    reverse: vi.fn(async (input) => ({
      command: input.direction,
      status: "reversed" as const,
      isError: false,
      text: "status: reversed",
    })),
    undoTurn: vi.fn(async () => ({
      command: "undo" as const,
      status: "reversed" as const,
      isError: false,
      text: "status: reversed",
    })),
    redoTurn: vi.fn(async () => ({
      command: "redo" as const,
      status: "reversed" as const,
      isError: false,
      text: "status: reversed",
    })),
    invalidateThread: vi.fn(),
    ...overrides,
  };
}

function emptyCommit(responseId: string): Awaited<ReturnType<AgentEditCore["commitResponse"]>> {
  return {
    responseId,
    documentCount: 0,
    updateCount: 0,
    documents: [],
    stagedCreates: { committed: [], discarded: [] },
  };
}

function createRouter(input: {
  mode:
    | "direct"
    | "draft"
    | Promise<"direct" | "draft">
    | (() => "direct" | "draft" | Promise<"direct" | "draft">);
  hasMaterialDraft?: boolean;
  draftWrite?: (fence: DraftSessionFence, command: WriteCommand) => void;
  liveCore?: AgentEditCore;
  resolveThreadWorkId?: (threadId: ThreadId) => WorkId | null;
  createDraftCommitDestination?: (input: {
    draftFence: Pick<
      DraftSessionFence,
      "capture" | "expectedDraftId" | "hasCapturedDraftId" | "preexistingDraftIds"
    >;
  }) => ResponseCommitDestination;
}) {
  const liveCore = input.liveCore ?? createCore();
  const draftCores: AgentEditCore[] = [];
  const router = createDraftWriteModeRouter({
    liveUtilityCore: liveCore,
    createDraftCore: () => {
      const draftFence = createDraftSessionFence();
      const draftCore = Object.assign(
        createCore({
          write: vi.fn(async (command: WriteCommand) => {
            input.draftWrite?.(draftFence, command);
            return {
              command: command.command,
              status: "success" as const,
              isError: false,
              text: "status: success",
            };
          }),
        }),
        { draftFence },
      );
      draftCores.push(draftCore);
      return draftCore;
    },
    resolveThreadWorkId: async (threadId) => input.resolveThreadWorkId?.(threadId) ?? WORK_ID,
    resolveWorkWriteMode: async () =>
      typeof input.mode === "function" ? input.mode() : input.mode,
    hasMaterialDraft: async () => input.hasMaterialDraft ?? true,
    createDraftFence: createDraftSessionFence,
    createDraftCommitDestination: ({ draftFence }) =>
      input.createDraftCommitDestination?.({ draftFence }) ?? {
        projection: false,
        attachRuntime: false,
        recoverCommittedResponseProjection: false,
        committedSnapshot: () => undefined,
        journal: {
          appendBatch: async (entries) => {
            draftFence.capture({ documentId: DOC_ID, threadId: THREAD_ID, draftId: "draft-1" });
            return entries.map((_, index) => ({ seq: index + 1, wId: index + 1 }));
          },
        },
      },
    threads: { findById: vi.fn() },
    refreshLiveProjection: vi.fn(async () => {}),
  });

  return { router, liveCore, draftCores };
}

const insertCommand: WriteCommand = {
  command: "insert",
  file: "chapter.md",
  documentId: DOC_ID,
  content: "new prose",
};

const undoCommand: WriteCommand = {
  command: "undo",
  file: "chapter.md",
  documentId: DOC_ID,
};

describe("createDraftWriteModeRouter", () => {
  it("does not count pending direct-mode resolution as an in-flight draft session", async () => {
    const mode = deferred<"direct" | "draft">();
    const { router } = createRouter({ mode: mode.promise });

    const write = router.agentEditCore.write(insertCommand, {
      responseId: "response-1",
      threadId: THREAD_ID,
    });

    expect(router.countInFlightDraftSessionsByWork({ workId: WORK_ID })).toBe(0);

    mode.resolve("direct");
    await write;
    expect(router.countInFlightDraftSessionsByWork({ workId: WORK_ID })).toBe(0);
  });

  it("counts only draft sessions whose fence captured a draft id", async () => {
    const preMaterial = createRouter({ mode: "draft" });
    await preMaterial.router.agentEditCore.write(insertCommand, {
      responseId: "response-1",
      threadId: THREAD_ID,
    });
    expect(preMaterial.router.countInFlightDraftSessionsByWork({ workId: WORK_ID })).toBe(0);

    const material = createRouter({
      mode: "draft",
      draftWrite: (fence) => {
        fence.capture({ documentId: DOC_ID, threadId: THREAD_ID, draftId: "draft-1" });
      },
    });
    await material.router.agentEditCore.write(insertCommand, {
      responseId: "response-2",
      threadId: THREAD_ID,
    });
    expect(material.router.countInFlightDraftSessionsByWork({ workId: WORK_ID })).toBe(1);
  });

  it("routes undo to live while draft session has not materialized", async () => {
    const liveCore = createCore();
    const { router } = createRouter({ mode: "draft", liveCore });

    const result = await router.agentEditCore.write(undoCommand, {
      responseId: "response-1",
      threadId: THREAD_ID,
    });

    expect(result.status).toBe("success");
    expect(liveCore.write).toHaveBeenCalledWith(undoCommand, {
      responseId: "response-1",
      threadId: THREAD_ID,
    });
  });

  it("returns an explicit unsupported result for direct undo APIs after draft writes materialize", async () => {
    const liveCore = createCore();
    const { router } = createRouter({
      mode: "draft",
      liveCore,
      draftWrite: (fence) => {
        fence.capture({ documentId: DOC_ID, threadId: THREAD_ID, draftId: "draft-1" });
      },
    });

    await router.agentEditCore.write(insertCommand, {
      responseId: "response-1",
      threadId: THREAD_ID,
    });

    await expect(router.agentEditCore.getAvailability(DOC_ID, THREAD_ID)).resolves.toEqual({
      undo: false,
      redo: false,
    });
    await expect(router.agentEditCore.undo(DOC_ID, THREAD_ID)).resolves.toMatchObject({
      command: "undo",
      status: "invalid_write",
      isError: true,
    });
    expect(liveCore.undo).not.toHaveBeenCalled();
  });

  it("returns an explicit unsupported result for undo after draft writes materialize", async () => {
    const liveCore = createCore();
    const { router } = createRouter({
      mode: "draft",
      liveCore,
      draftWrite: (fence, command) => {
        if (command.command === "insert") {
          fence.capture({ documentId: DOC_ID, threadId: THREAD_ID, draftId: "draft-1" });
        }
      },
    });

    await router.agentEditCore.write(insertCommand, {
      responseId: "response-1",
      threadId: THREAD_ID,
    });
    const result = await router.agentEditCore.write(undoCommand, {
      responseId: "response-1",
      threadId: THREAD_ID,
    });

    expect(result).toMatchObject({
      command: "undo",
      status: "invalid_write",
      isError: true,
    });
    expect(result.text).toContain("not supported for draft-scoped edits");
    expect(liveCore.write).not.toHaveBeenCalledWith(undoCommand, expect.anything());
  });
  it("counts a committing draft redirect before it materializes a draft row", async () => {
    let router!: ReturnType<typeof createDraftWriteModeRouter>;
    let modeChecks = 0;
    const created = createRouter({
      mode: () => {
        modeChecks += 1;
        if (modeChecks === 2) {
          expect(router.countInFlightDraftSessionsByWork({ workId: WORK_ID })).toBe(1);
          return "direct";
        }
        return "draft";
      },
      hasMaterialDraft: false,
    });
    router = created.router;

    await router.agentEditCore.write(insertCommand, {
      responseId: "response-commit-window",
      threadId: THREAD_ID,
    });

    await expect(
      router.agentEditCore.commitResponse("response-commit-window"),
    ).resolves.toMatchObject({
      status: "draft_closed",
      mode: "draft",
    });
    expect(created.liveCore.rollbackResponse).toHaveBeenCalledWith("response-commit-window");
    expect(created.liveCore.commitResponse).not.toHaveBeenCalled();
    expect(router.countInFlightDraftSessionsByWork({ workId: WORK_ID })).toBe(0);
  });

  it("blocks undo from another thread in the same work while a material draft exists", async () => {
    const liveCore = createCore();
    const { router } = createRouter({
      mode: "draft",
      liveCore,
      draftWrite: (fence) => {
        fence.capture({ documentId: DOC_ID, threadId: THREAD_ID, draftId: "draft-1" });
      },
    });

    await router.agentEditCore.write(insertCommand, {
      responseId: "response-work-draft",
      threadId: THREAD_ID,
    });

    await expect(router.agentEditCore.undo(DOC_ID, THREAD_B_ID)).resolves.toMatchObject({
      command: "undo",
      status: "invalid_write",
      isError: true,
    });
    expect(liveCore.undo).not.toHaveBeenCalled();
  });

  it("returns typed undo unsupported before stale material draft sessions hit the closed guard", async () => {
    const liveCore = createCore();
    const { router } = createRouter({
      mode: "draft",
      liveCore,
      draftWrite: (fence, command) => {
        if (command.command === "insert") {
          fence.capture({ documentId: DOC_ID, threadId: THREAD_ID, draftId: "draft-1" });
        }
      },
    });

    await router.agentEditCore.write(insertCommand, {
      responseId: "response-stale-draft",
      threadId: THREAD_ID,
    });
    await router.invalidateDraft({ documentId: DOC_ID, threadId: THREAD_ID });

    const result = await router.agentEditCore.write(undoCommand, {
      responseId: "response-stale-draft",
      threadId: THREAD_ID,
    });

    expect(result).toMatchObject({
      command: "undo",
      status: "invalid_write",
      isError: true,
    });
    expect(result.text).toContain("not supported for draft-scoped edits");
    expect(liveCore.write).not.toHaveBeenCalledWith(undoCommand, expect.anything());
  });

  it("keeps a draft redirect session when destination creation fails so retry cannot fall back to live", async () => {
    let mode: "direct" | "draft" = "draft";
    const defaultLiveCommits = vi.fn();
    const liveCore = createCore({
      commitResponse: vi.fn(
        async (
          responseId: string,
          options?: { destination?: ResponseCommitDestination },
        ): Promise<Awaited<ReturnType<AgentEditCore["commitResponse"]>>> => {
          if (!options?.destination) defaultLiveCommits();
          await options?.destination?.journal?.appendBatch([]);
          return emptyCommit(responseId);
        },
      ),
    });
    let destinationFactoryCalls = 0;
    const { router } = createRouter({
      mode: () => mode,
      hasMaterialDraft: false,
      liveCore,
      createDraftCommitDestination: ({ draftFence }) => {
        destinationFactoryCalls += 1;
        if (destinationFactoryCalls === 1) throw new Error("destination unavailable");
        return {
          projection: false,
          attachRuntime: false,
          recoverCommittedResponseProjection: false,
          committedSnapshot: () => undefined,
          journal: {
            appendBatch: async () => {
              draftFence.capture({ documentId: DOC_ID, threadId: THREAD_ID, draftId: "draft-1" });
              return [];
            },
          },
        };
      },
    });

    await router.agentEditCore.write(insertCommand, {
      responseId: "response-destination-fails",
      threadId: THREAD_ID,
    });
    await expect(
      router.finalizeResponseCommit("response-destination-fails", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    ).rejects.toThrow("destination unavailable");

    mode = "direct";
    await expect(
      router.finalizeResponseCommit("response-destination-fails", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    ).resolves.toMatchObject({ status: "draft_closed" });
    expect(defaultLiveCommits).not.toHaveBeenCalled();
  });

  it("reuses the same draft destination after a pre-durable append failure", async () => {
    const defaultLiveCommits = vi.fn();
    const liveCore = createCore({
      commitResponse: vi.fn(
        async (
          responseId: string,
          options?: { destination?: ResponseCommitDestination },
        ): Promise<Awaited<ReturnType<AgentEditCore["commitResponse"]>>> => {
          if (!options?.destination) defaultLiveCommits();
          await options?.destination?.journal?.appendBatch([]);
          return emptyCommit(responseId);
        },
      ),
    });
    let destinationFactoryCalls = 0;
    let appendCalls = 0;
    const { router } = createRouter({
      mode: "draft",
      hasMaterialDraft: false,
      liveCore,
      createDraftCommitDestination: ({ draftFence }) => {
        destinationFactoryCalls += 1;
        return {
          projection: false,
          attachRuntime: false,
          recoverCommittedResponseProjection: false,
          committedSnapshot: () => undefined,
          journal: {
            appendBatch: async () => {
              appendCalls += 1;
              if (appendCalls === 1) throw new Error("append failed before durable write");
              draftFence.capture({ documentId: DOC_ID, threadId: THREAD_ID, draftId: "draft-1" });
              return [];
            },
          },
        };
      },
    });

    await router.agentEditCore.write(insertCommand, {
      responseId: "response-append-fails",
      threadId: THREAD_ID,
    });
    await expect(
      router.finalizeResponseCommit("response-append-fails", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    ).rejects.toThrow("append failed before durable write");

    await expect(
      router.finalizeResponseCommit("response-append-fails", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    ).resolves.toMatchObject({ status: "committed" });
    expect(destinationFactoryCalls).toBe(1);
    expect(defaultLiveCommits).not.toHaveBeenCalled();
  });

  it("keeps a material draft-core response reachable for rollback after commit failure", async () => {
    const draftCore = Object.assign(
      createCore({
        commitResponse: vi.fn(async () => {
          throw new Error("draft core commit failed");
        }),
      }),
      { draftFence: createDraftSessionFence() },
    );
    const liveCore = createCore();
    const directRouter = createDraftWriteModeRouter({
      liveUtilityCore: liveCore,
      createDraftCore: () => draftCore,
      resolveThreadWorkId: async () => WORK_ID,
      resolveWorkWriteMode: async () => "draft",
      hasMaterialDraft: async () => true,
      createDraftFence: createDraftSessionFence,
      createDraftCommitDestination: ({ draftFence }) => ({
        projection: false,
        attachRuntime: false,
        recoverCommittedResponseProjection: false,
        committedSnapshot: () => undefined,
        journal: {
          appendBatch: async () => {
            draftFence.capture({ documentId: DOC_ID, threadId: THREAD_ID, draftId: "draft-1" });
            return [];
          },
        },
      }),
      threads: { findById: vi.fn() },
      refreshLiveProjection: vi.fn(async () => {}),
    });

    await directRouter.agentEditCore.write(insertCommand, {
      responseId: "response-material-fails",
      threadId: THREAD_ID,
    });
    await expect(
      directRouter.finalizeResponseCommit("response-material-fails", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    ).rejects.toThrow("draft core commit failed");

    await directRouter.finalizeResponseRollback("response-material-fails");
    expect(draftCore.rollbackResponse).toHaveBeenCalledWith("response-material-fails");
    expect(liveCore.rollbackResponse).not.toHaveBeenCalledWith("response-material-fails");
  });
});
