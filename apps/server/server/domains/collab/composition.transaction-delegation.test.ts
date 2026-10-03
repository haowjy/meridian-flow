/** Unit contract for thread-peer response transaction delegation and ownership settlement. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { asLiveAgentEditCore } from "./domain/agent-edit-cores.js";
import { createThreadPeerAgentEditCore } from "./domain/thread-peer-core-pool.js";
import {
  createFakeThreadPeerCores,
  inProcessResponseTransactions,
} from "./test-support/thread-peer-pool-fakes.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000003" as ThreadId;
const DRAFT = { kind: "draft", workId: "work-1" as WorkId, workSlug: "work" } as const;

function createCore(
  cores = createFakeThreadPeerCores(),
  commitThreadResponseAtomically: <T>(operation: () => Promise<T>) => Promise<T> = (operation) =>
    operation(),
) {
  const core = createThreadPeerAgentEditCore({
    liveUtilityCore: asLiveAgentEditCore(cores.liveCore.asCore()),
    createThreadCore: () => cores.threadCore.asCore(),
    reversalHistory: cores.history.reader,
    discardThreadPeerBranches: async () => {},
    pullThreadPeer: cores.history.pullThreadPeer,
    commitThreadResponseAtomically,
    ...inProcessResponseTransactions,
  });
  return { core, ...cores };
}

describe("thread-peer response transaction delegation", () => {
  it("routes reversals without active Draft history through the live core", async () => {
    const { core, liveCore, threadCore } = createCore();

    await core.write(
      { command: "undo", file: "alpha.md", all: true },
      { threadId: THREAD_ID, sessionId: THREAD_ID, turnId: "turn-post-apply", destination: DRAFT },
    );

    expect(liveCore.write).toHaveBeenCalledWith(
      expect.objectContaining({ command: "undo" }),
      expect.not.objectContaining({
        interactionContext: expect.objectContaining({ mode: "threadPeer" }),
      }),
    );
    expect(threadCore.write).not.toHaveBeenCalled();
  });

  it("does not let a live reversal route a later response write around Draft", async () => {
    const { core, liveCore, threadCore } = createCore();
    const context = {
      threadId: THREAD_ID,
      sessionId: THREAD_ID,
      turnId: "turn-live-then-draft",
      responseId: "response-live-then-draft",
      destination: DRAFT,
    };

    await core.write({ command: "undo", file: "alpha.md", all: true }, context);
    await core.write({ command: "insert", file: "alpha.md", content: "Draft content." }, context);
    await core.commitResponse(context.responseId);

    expect(liveCore.write).toHaveBeenCalledOnce();
    expect(threadCore.write).toHaveBeenCalledOnce();
    expect(threadCore.commitResponse).toHaveBeenCalledOnce();
    expect(liveCore.commitResponse).not.toHaveBeenCalled();
  });

  it("rolls back the document commit when tool-result finalization fails", async () => {
    const durable: string[] = [];
    const responseId = "response-finalize";
    const cores = createFakeThreadPeerCores();
    cores.threadCore.commitResponse.mockImplementation(async (id) => {
      durable.push("document");
      return {
        status: "committed",
        responseId: id,
        documentCount: 1,
        updateCount: 1,
        documents: [],
        stagedCreates: { committed: [], discarded: [] },
      };
    });
    const { core } = createCore(cores, async (operation) => {
      const before = [...durable];
      try {
        return await operation();
      } catch (cause) {
        durable.splice(0, durable.length, ...before);
        throw cause;
      }
    });
    await core.write(
      { command: "insert", file: "alpha.md", content: "Draft content." },
      {
        threadId: THREAD_ID,
        sessionId: THREAD_ID,
        turnId: "turn-finalize",
        responseId,
        destination: DRAFT,
      },
    );

    await expect(
      core.commitResponse(responseId, {
        beforeTransactionCommit: async () => {
          durable.push("tool-result");
          throw new Error("injected finalization crash");
        },
      }),
    ).rejects.toThrow("injected finalization crash");
    expect(durable).toEqual([]);
  });

  it("releases facade ownership when a degraded raw rollback completes honestly", async () => {
    const responseId = "response-rollback";
    const cores = createFakeThreadPeerCores();
    cores.threadCore.rollbackResponse.mockImplementation(async (id, options) => {
      (
        options as
          | { deferFinalization?(participant: { commit(): void; abort(): void }): void }
          | undefined
      )?.deferFinalization?.({ commit: () => {}, abort: () => {} });
      // The real committer returns this after evicting runtimes when restoration fails.
      return {
        status: "rolledBackDegraded",
        responseId: id,
        stagedCreates: { committed: [], discarded: [] },
        restorationFailed: true,
      } as never;
    });
    const { core, liveCore, threadCore } = createCore(cores);
    await core.write(
      { command: "insert", file: "alpha.md", content: "Draft content." },
      {
        threadId: THREAD_ID,
        sessionId: THREAD_ID,
        turnId: "turn-rollback",
        responseId,
        destination: DRAFT,
      },
    );

    await expect(core.rollbackResponse(responseId)).resolves.toMatchObject({
      status: "rolledBackDegraded",
      restorationFailed: true,
    });
    await core.rollbackResponse(responseId);

    expect(threadCore.rollbackResponse).toHaveBeenCalledOnce();
    expect(liveCore.rollbackResponse).toHaveBeenCalledOnce();
  });
});
