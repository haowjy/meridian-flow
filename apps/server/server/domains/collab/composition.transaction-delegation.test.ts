/** Unit contract: the thread-peer façade delegates response commits to the configured transaction runner.
 * Process-local unit-of-work rollback coverage is pending the concurrent-safety design round. */
import type { AgentEditCore } from "@meridian/agent-edit";
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createThreadPeerAgentEditCore } from "./composition.js";
import { asLiveAgentEditCore } from "./domain/agent-edit-cores.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000003" as ThreadId;

describe("thread-peer response transaction delegation", () => {
  it("runs a response commit through the configured transaction boundary", async () => {
    const durableJournal: string[] = [];
    const commitResponse = vi.fn(async () => {
      durableJournal.push("alpha.md");
      durableJournal.push("beta.md");
      throw new Error("injected second-document flush failure");
    });
    const fakeCore = {
      write: vi.fn(async () => ({ status: "success", isError: false, text: "" })),
      commitResponse,
      bufferedUpdatesForDoc: vi.fn(() => []),
      stagedCreatedDocumentIds: vi.fn(() => []),
      invalidateThread: vi.fn(async () => {}),
    } as unknown as AgentEditCore;
    let transactionCalls = 0;
    const transaction = async <T>(operation: () => Promise<T>): Promise<T> => {
      transactionCalls += 1;
      const before = [...durableJournal];
      try {
        return await operation();
      } catch (cause) {
        durableJournal.splice(0, durableJournal.length, ...before);
        throw cause;
      }
    };
    const core = createThreadPeerAgentEditCore({
      liveUtilityCore: asLiveAgentEditCore(fakeCore),
      createThreadCore: () => fakeCore,
      commitThreadResponseAtomically: transaction,
    });
    const responseId = "response-two-docs";
    await core.write(
      { command: "read", file: "alpha.md" },
      { threadId: THREAD_ID, sessionId: THREAD_ID, turnId: "turn-1", responseId },
    );

    await expect(core.commitResponse(responseId)).rejects.toThrow(
      "injected second-document flush failure",
    );
    expect(durableJournal).toEqual([]);
    expect(transactionCalls).toBe(1);
  });
});
