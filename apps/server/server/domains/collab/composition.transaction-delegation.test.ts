/** Unit contract for thread-peer response transaction delegation and ownership settlement. */
import type { AgentEditCore } from "@meridian/agent-edit/integration";
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { asLiveAgentEditCore } from "./domain/agent-edit-cores.js";
import {
  enlistResponseParticipant,
  runResponseTransaction,
} from "./domain/response-transaction.js";
import { createThreadPeerAgentEditCore } from "./domain/thread-peer-core-pool.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000003" as ThreadId;
const threadPeerPoolDefaults = {
  shouldUseLiveReversal: async () => false,
  discardThreadPeerBranches: async () => {},
  pullThreadPeer: async () => undefined,
  responseTransactionSettlement: {
    deferUntilCommit: () => false,
    deferUntilRollback: () => false,
  },
  responseTransactions: {
    enlist: enlistResponseParticipant,
    run: runResponseTransaction,
  },
};

describe("thread-peer response transaction delegation", () => {
  it("routes reversals without active Draft history through the live core", async () => {
    const liveWrite = vi.fn(async () => ({ status: "reconciled", isError: false, text: "" }));
    const threadWrite = vi.fn(async () => ({ status: "reconciled", isError: false, text: "" }));
    const coreShape = {
      commitResponse: vi.fn(),
      hasResponseDocument: vi.fn(() => false),
      withResponseDocument: vi.fn(async () => null),
      responseDocuments: vi.fn(() => ({ staged: [], created: [] })),
      invalidateThread: vi.fn(async () => {}),
    };
    const liveCore = { ...coreShape, write: liveWrite } as unknown as AgentEditCore;
    const threadCore = { ...coreShape, write: threadWrite } as unknown as AgentEditCore;
    const shouldUseLiveReversal = vi.fn(async () => true);
    const core = createThreadPeerAgentEditCore({
      ...threadPeerPoolDefaults,
      liveUtilityCore: asLiveAgentEditCore(liveCore),
      createThreadCore: () => threadCore,
      shouldUseLiveReversal,
      pullThreadPeer: async () => ({
        branchGeneration: 2,
        attributionBaseline: new Uint8Array(),
      }),
      commitThreadResponseAtomically: async (operation) => operation(),
    });

    await core.write(
      { command: "undo", file: "alpha.md", all: true },
      { threadId: THREAD_ID, sessionId: THREAD_ID, turnId: "turn-post-apply" },
    );

    expect(shouldUseLiveReversal).toHaveBeenCalledWith({
      documentId: "alpha.md",
      threadId: THREAD_ID,
    });
    expect(liveWrite).toHaveBeenCalledWith(
      expect.objectContaining({ command: "undo" }),
      expect.not.objectContaining({
        interactionContext: expect.objectContaining({ mode: "threadPeer" }),
      }),
    );
    expect(threadWrite).not.toHaveBeenCalled();
  });

  it("does not let a live reversal route a later response write around Draft", async () => {
    const liveWrite = vi.fn(async () => ({ status: "reconciled", isError: false, text: "" }));
    const threadWrite = vi.fn(async () => ({ status: "success", isError: false, text: "" }));
    const coreShape = {
      commitResponse: vi.fn(async () => ({ status: "committed" })),
      hasResponseDocument: vi.fn(() => false),
      withResponseDocument: vi.fn(async () => null),
      responseDocuments: vi.fn(() => ({ staged: [], created: [] })),
      invalidateThread: vi.fn(async () => {}),
    };
    const liveCore = { ...coreShape, write: liveWrite } as unknown as AgentEditCore;
    const threadCore = { ...coreShape, write: threadWrite } as unknown as AgentEditCore;
    const core = createThreadPeerAgentEditCore({
      ...threadPeerPoolDefaults,
      liveUtilityCore: asLiveAgentEditCore(liveCore),
      createThreadCore: () => threadCore,
      shouldUseLiveReversal: async () => true,
      commitThreadResponseAtomically: async (operation) => operation(),
    });
    const context = {
      threadId: THREAD_ID,
      sessionId: THREAD_ID,
      turnId: "turn-live-then-draft",
      responseId: "response-live-then-draft",
    };

    await core.write({ command: "undo", file: "alpha.md", all: true }, context);
    await core.write({ command: "insert", file: "alpha.md", content: "Draft content." }, context);
    await core.commitResponse(context.responseId);

    expect(liveWrite).toHaveBeenCalledOnce();
    expect(threadWrite).toHaveBeenCalledOnce();
    expect(coreShape.commitResponse).toHaveBeenCalledOnce();
  });

  it("rolls back the document commit when tool-result finalization fails", async () => {
    const durable: string[] = [];
    const result = {
      status: "committed" as const,
      responseId: "response-finalize",
      documentCount: 1,
      updateCount: 1,
      documents: [],
      stagedCreates: { committed: [], discarded: [] },
    };
    const threadCore = {
      write: vi.fn(async () => ({ status: "success", isError: false, text: "" })),
      commitResponse: vi.fn(async () => {
        durable.push("document");
        return result;
      }),
      hasResponseDocument: vi.fn(() => false),
      withResponseDocument: vi.fn(async () => null),
      responseDocuments: vi.fn(() => ({ staged: [], created: [] })),
      invalidateThread: vi.fn(async () => {}),
    } as unknown as AgentEditCore;
    const core = createThreadPeerAgentEditCore({
      ...threadPeerPoolDefaults,
      liveUtilityCore: asLiveAgentEditCore(threadCore),
      createThreadCore: () => threadCore,
      commitThreadResponseAtomically: async (operation) => {
        const before = [...durable];
        try {
          return await operation();
        } catch (cause) {
          durable.splice(0, durable.length, ...before);
          throw cause;
        }
      },
    });
    await core.write(
      { command: "read", file: "alpha.md" },
      {
        threadId: THREAD_ID,
        sessionId: THREAD_ID,
        turnId: "turn-finalize",
        responseId: result.responseId,
      },
    );

    await expect(
      core.commitResponse(result.responseId, {
        beforeTransactionCommit: async () => {
          durable.push("tool-result");
          throw new Error("injected finalization crash");
        },
      }),
    ).rejects.toThrow("injected finalization crash");
    expect(durable).toEqual([]);
  });

  it("releases facade ownership when a degraded raw rollback completes honestly", async () => {
    const threadRollback = vi.fn(
      async (
        _responseId: string,
        options?: {
          deferFinalization?(participant: {
            commit(): void | Promise<void>;
            abort(): void | Promise<void>;
          }): void;
        },
      ) => {
        options?.deferFinalization?.({
          commit: () => {},
          abort: () => {},
        });
        // The real committer returns this after evicting runtimes when restoration fails.
        return {
          status: "rolledBackDegraded" as const,
          responseId: "response-rollback",
          stagedCreates: { committed: [], discarded: [] },
          restorationFailed: true as const,
        };
      },
    );
    const liveRollback = vi.fn(async () => ({
      status: "rolledBack" as const,
      responseId: "response-rollback",
      stagedCreates: { committed: [], discarded: [] },
    }));
    const threadCore = {
      write: vi.fn(async () => ({ status: "success", isError: false, text: "" })),
      rollbackResponse: threadRollback,
      hasResponseDocument: vi.fn(() => false),
      withResponseDocument: vi.fn(async () => null),
      responseDocuments: vi.fn(() => ({ staged: [], created: [] })),
      invalidateThread: vi.fn(async () => {}),
    } as unknown as AgentEditCore;
    const liveCore = {
      ...threadCore,
      rollbackResponse: liveRollback,
    } as unknown as AgentEditCore;
    const core = createThreadPeerAgentEditCore({
      ...threadPeerPoolDefaults,
      liveUtilityCore: asLiveAgentEditCore(liveCore),
      createThreadCore: () => threadCore,
      commitThreadResponseAtomically: async (operation) => operation(),
    });
    const responseId = "response-rollback";
    await core.write(
      { command: "read", file: "alpha.md" },
      { threadId: THREAD_ID, sessionId: THREAD_ID, turnId: "turn-rollback", responseId },
    );

    await expect(core.rollbackResponse(responseId)).resolves.toMatchObject({
      status: "rolledBackDegraded",
      restorationFailed: true,
    });
    await core.rollbackResponse(responseId);

    expect(threadRollback).toHaveBeenCalledOnce();
    expect(liveRollback).toHaveBeenCalledOnce();
  });
});
