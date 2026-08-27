/** Agent-edit response settlement wiring protocol coverage. */
import {
  type AgentEditCore,
  modelResult,
  type ResponseCommitSuccessResult,
} from "@meridian/agent-edit/integration";
import { describe, expect, it } from "vitest";
import { asThreadPeerAgentEditCore } from "../domains/collab/domain/agent-edit-cores.js";
import { createAgentEditResponseWriteLifecycle } from "./wired-core-tools.js";

function agentEditCoreWithCommit(commitResult: ResponseCommitSuccessResult): AgentEditCore {
  return {
    write: async () => ({
      command: "read",
      status: "success",
      phase: "committed",
      isError: false,
      text: "",
      result: modelResult({ command: "read", status: "success", phase: "committed" }),
    }),
    recover: async () => {},
    commitResponse: async () => commitResult,
    rollbackResponse: async () => ({
      status: "rolledBack",
      responseId: commitResult.responseId,
      stagedCreates: { committed: [], discarded: [] },
    }),
    hasResponseDocument: () => false,
    withResponseDocument: async () => null,
    responseDocuments: () => ({ staged: [], created: [] }),
    getAvailability: async () => ({ undo: false, redo: false }),
    undo: async () => ({
      command: "undo",
      status: "nothing_to_undo",
      isError: false,
      text: "",
      result: modelResult({ command: "undo", status: "nothing_to_undo" }),
    }),
    redo: async () => ({
      command: "redo",
      status: "nothing_to_redo",
      isError: false,
      text: "",
      result: modelResult({ command: "redo", status: "nothing_to_redo" }),
    }),
    reverse: async (input) => ({
      command: input.direction,
      status: input.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
      isError: false,
      text: "",
      result: modelResult({
        command: input.direction,
        status: input.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
      }),
    }),
    invalidateThread: async () => {},
  };
}

function responseFinalizerWithCommit(commitResult: ResponseCommitSuccessResult) {
  return {
    finalizeResponseCommit: async () => ({
      status: "committed" as const,
      documents: commitResult.documents,
      stagedCreates: commitResult.stagedCreates,
    }),
    finalizeResponseRollback: async () => ({
      stagedCreates: { committed: [], discarded: [] },
    }),
    resolveThreadWriteMode: async () => "direct" as const,
  };
}

describe("agent-edit response write lifecycle", () => {
  it("commits response through the collab finalizer and maps concurrent edits", async () => {
    const finalized: string[] = [];
    const commitResult: ResponseCommitSuccessResult = {
      status: "committed",
      responseId: "response-1",
      documentCount: 1,
      updateCount: 1,
      documents: [
        {
          documentId: "doc-1",
          updateCount: 1,
          receipts: [
            {
              writeId: "w1",
              settlementId: "write-1",
              result: modelResult({
                command: "replace",
                status: "success",
                phase: "committed",
                payload: { write: { id: "w1" } },
              }),
            },
          ],
          concurrentEdits: { human: ["abcd"], agent: [], runs: [] },
          lateSweep: {
            affectedBlockHashes: ["abcd"],
            capturedDeletedBodies: [{ hash: "abcd", body: "Writer body." }],
            sweptContent: true,
            beforeContentRef: 42,
          },
        },
      ],
      stagedCreates: { committed: [], discarded: [] },
    };
    const lifecycle = createAgentEditResponseWriteLifecycle({
      documentSync: {
        agentEdit: () => asThreadPeerAgentEditCore(agentEditCoreWithCommit(commitResult)),
        refreshDocumentProjection: async () => {
          throw new Error("response lifecycle should not refresh projections directly");
        },
        finalizeResponseCommit: async (responseId, ctx) => {
          const result = await agentEditCoreWithCommit(commitResult).commitResponse(responseId);
          if (result.status !== "committed") throw new Error("expected committed response");
          for (const document of result.documents) {
            finalized.push(`${responseId}:${document.documentId}:${ctx.threadId}:${ctx.turnId}`);
          }
          return {
            status: "committed",
            documents: result.documents,
            stagedCreates: result.stagedCreates,
          };
        },
        finalizeResponseRollback: async () => ({
          stagedCreates: { committed: [], discarded: [] },
        }),
      },
    });

    await expect(
      lifecycle.commitResponse("response-1", { threadId: "thread-1", turnId: "turn-1" }),
    ).resolves.toEqual({
      status: "committed",
      receipts: [
        {
          documentId: "doc-1",
          receipt: {
            writeId: "w1",
            settlementId: "write-1",
            result: modelResult({
              command: "replace",
              status: "success",
              phase: "committed",
              payload: { write: { id: "w1" } },
            }),
          },
        },
      ],
      concurrentEdits: [
        { documentId: "doc-1", concurrentEdits: { human: ["abcd"], agent: [], runs: [] } },
      ],
    });

    expect(finalized).toEqual(["response-1:doc-1:thread-1:turn-1"]);
  });

  it("commits response when there are no concurrent edits", async () => {
    const lifecycle = createAgentEditResponseWriteLifecycle({
      documentSync: {
        agentEdit: () =>
          asThreadPeerAgentEditCore(
            agentEditCoreWithCommit({
              status: "committed",
              responseId: "response-1",
              documentCount: 1,
              updateCount: 1,
              documents: [{ documentId: "doc-1", updateCount: 1, receipts: [] }],
              stagedCreates: { committed: [], discarded: [] },
            }),
          ),
        refreshDocumentProjection: async () => {},
        ...responseFinalizerWithCommit({
          status: "committed",
          responseId: "response-1",
          documentCount: 1,
          updateCount: 1,
          documents: [{ documentId: "doc-1", updateCount: 1, receipts: [] }],
          stagedCreates: { committed: [], discarded: [] },
        }),
      },
    });

    await expect(
      lifecycle.commitResponse("response-1", { threadId: "thread-1", turnId: "turn-1" }),
    ).resolves.toEqual({ status: "committed", receipts: [], concurrentEdits: [] });
  });

  it("surfaces draft_closed as an explicit response commit result", async () => {
    const lifecycle = createAgentEditResponseWriteLifecycle({
      documentSync: {
        agentEdit: () =>
          asThreadPeerAgentEditCore(
            agentEditCoreWithCommit({
              status: "committed",
              responseId: "response-closed",
              documentCount: 0,
              updateCount: 0,
              documents: [],
              stagedCreates: { committed: [], discarded: [] },
            }),
          ),
        refreshDocumentProjection: async () => {},
        finalizeResponseCommit: async () => ({
          status: "draft_closed" as const,
          responseId: "response-closed",
          mode: "draft" as const,
          documents: [],
          stagedCreates: { committed: [], discarded: [] },
        }),
        finalizeResponseRollback: async () => ({
          stagedCreates: { committed: [], discarded: [] },
        }),
      },
    });

    await expect(
      lifecycle.commitResponse("response-closed", { threadId: "thread-1", turnId: "turn-1" }),
    ).resolves.toEqual({
      status: "draft_closed",
      responseId: "response-closed",
      mode: "draft",
    });
  });
  it("passes thread and turn context into response rollback finalization", async () => {
    const calls: Array<{ responseId: string; threadId: string; turnId: string }> = [];
    const lifecycle = createAgentEditResponseWriteLifecycle({
      documentSync: {
        agentEdit: () =>
          asThreadPeerAgentEditCore(
            agentEditCoreWithCommit({
              status: "committed",
              responseId: "response-rollback",
              documentCount: 0,
              updateCount: 0,
              documents: [],
              stagedCreates: { committed: [], discarded: [] },
            }),
          ),
        refreshDocumentProjection: async () => {},
        finalizeResponseCommit: async () => ({
          status: "committed" as const,
          documents: [],
          stagedCreates: { committed: [], discarded: [] },
        }),
        finalizeResponseRollback: async (responseId, ctx) => {
          calls.push({ responseId, threadId: ctx.threadId, turnId: ctx.turnId });
          return { stagedCreates: { committed: [], discarded: [] } };
        },
      },
    });

    await lifecycle.rollbackResponse("response-rollback", {
      threadId: "thread-rollback",
      turnId: "turn-rollback",
    });

    expect(calls).toEqual([
      { responseId: "response-rollback", threadId: "thread-rollback", turnId: "turn-rollback" },
    ]);
  });
});
