import type { AgentEditCore, ResponseCommitResult } from "@meridian/agent-edit";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import { createAgentEditResponseWriteLifecycle } from "./wired-core-tools.js";

function agentEditCoreWithCommit(commitResult: ResponseCommitResult): AgentEditCore {
  return {
    write: async () => ({ command: "view", status: "success", isError: false, text: "" }),
    recover: async () => {},
    commitResponse: async () => commitResult,
    rollbackResponse: async () => ({
      responseId: commitResult.responseId,
      stagedCreates: { committed: [], discarded: [] },
    }),
    getAvailability: async () => ({ undo: false, redo: false }),
    undo: async () => ({
      command: "undo",
      status: "nothing_to_undo",
      isError: false,
      text: "",
    }),
    redo: async () => ({
      command: "redo",
      status: "nothing_to_redo",
      isError: false,
      text: "",
    }),
    undoTurn: async () => ({
      command: "undo",
      status: "nothing_to_undo",
      isError: false,
      text: "",
    }),
    redoTurn: async () => ({
      command: "redo",
      status: "nothing_to_redo",
      isError: false,
      text: "",
    }),
    invalidateThread: () => {},
  };
}

describe("agent-edit response write lifecycle", () => {
  it("returns post-commit concurrent edit echoes instead of discarding them", async () => {
    const refreshed: string[] = [];
    const commitResult: ResponseCommitResult = {
      responseId: "response-1",
      documentCount: 1,
      updateCount: 1,
      documents: [
        {
          documentId: "doc-1",
          updateCount: 1,
          concurrentEdits: { human: ["abcd"], agent: [] },
          echo: [{ writeId: "w1", hunks: [{ mode: "full", blocks: ["abcd|Who---—"] }] }],
          text: "status: success\n\nabcd|Who---—\n\nconcurrent edits:\n  human: abcd",
        },
      ],
      stagedCreates: { committed: [], discarded: [] },
    };
    const lifecycle = createAgentEditResponseWriteLifecycle({
      documentSync: {
        agentEdit: () => agentEditCoreWithCommit(commitResult),
        refreshDocumentProjection: async ({ documentId }) => {
          refreshed.push(documentId);
        },
      },
      eventSink: createInMemoryEventSink(),
    });

    const echoes = await lifecycle.commitResponse("response-1", {
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(refreshed).toEqual(["doc-1"]);
    expect(echoes).toEqual([{ documentId: "doc-1", text: commitResult.documents[0]?.text }]);
  });

  it("returns no post-commit echo when there are no concurrent edits", async () => {
    const lifecycle = createAgentEditResponseWriteLifecycle({
      documentSync: {
        agentEdit: () =>
          agentEditCoreWithCommit({
            responseId: "response-1",
            documentCount: 1,
            updateCount: 1,
            documents: [{ documentId: "doc-1", updateCount: 1 }],
            stagedCreates: { committed: [], discarded: [] },
          }),
        refreshDocumentProjection: async () => {},
      },
      eventSink: createInMemoryEventSink(),
    });

    await expect(
      lifecycle.commitResponse("response-1", { threadId: "thread-1", turnId: "turn-1" }),
    ).resolves.toEqual([]);
  });
});
