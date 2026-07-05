/** Unit coverage for response-scoped draft/live write-mode routing edges. */
import type { AgentEditCore, WriteCommand } from "@meridian/agent-edit";
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createDraftSessionFence,
  type DraftSessionFence,
} from "../adapters/drizzle-draft-agent-edit.js";
import { createDraftWriteModeRouter } from "./draft-write-mode-router.js";

const THREAD_ID = "thread-1" as ThreadId;
const WORK_ID = "work-1" as WorkId;
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

function createRouter(input: {
  mode: "direct" | "draft" | Promise<"direct" | "draft">;
  draftWrite?: (fence: DraftSessionFence, command: WriteCommand) => void;
  liveCore?: AgentEditCore;
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
    resolveThreadWorkId: async () => WORK_ID,
    resolveWorkWriteMode: async () => input.mode,
    threads: { findById: vi.fn() },
    markDraftCreatedDocument: vi.fn(async () => {}),
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
});
