import type { AgentEditCore, ResponseCommitResult } from "@meridian/agent-edit";
import { createWriteToolHarness } from "@meridian/agent-edit/test-support";
import { describe, expect, it } from "vitest";
import type { ContextPort } from "../domains/context/index.js";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import type { ToolHandlerContext } from "../domains/runtime/index.js";
import {
  createAgentEditResponseWriteLifecycle,
  createWiredCoreToolRegistrations,
} from "./wired-core-tools.js";

type TestWriteHandler = (input: unknown, ctx: ToolHandlerContext) => Promise<unknown>;

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
    reverse: async (input) => ({
      command: input.direction,
      status: input.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
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

describe("wired write tool", () => {
  it("forwards undo and redo to/from selectors through the model-facing tool boundary", async () => {
    const single = await seededWiredWrite();

    await expect(
      single.write({ command: "undo", path: single.filePath, to: "w3" }, single.ctx),
    ).resolves.toContain("status: reversed");
    const afterSingleUndo = String(
      await single.write({ command: "view", path: single.filePath }, single.ctx),
    );
    expect(afterSingleUndo).toContain("One");
    expect(afterSingleUndo).not.toContain("Three");

    await expect(
      single.write({ command: "redo", path: single.filePath, to: "w3" }, single.ctx),
    ).resolves.toContain("status: reversed");
    expect(await single.write({ command: "view", path: single.filePath }, single.ctx)).toContain(
      "Three",
    );

    const range = await seededWiredWrite();
    await expect(
      range.write({ command: "undo", path: range.filePath, from: "w2", to: "w5" }, range.ctx),
    ).resolves.toContain("status: reversed");
    const afterRangeUndo = String(
      await range.write({ command: "view", path: range.filePath }, range.ctx),
    );
    expect(afterRangeUndo).toContain("One");
    for (const removed of ["Two", "Three", "Four", "Five"]) {
      expect(afterRangeUndo).not.toContain(removed);
    }

    await expect(
      range.write({ command: "redo", path: range.filePath, from: "w2", to: "w5" }, range.ctx),
    ).resolves.toContain("status: reversed");
    const afterRangeRedo = String(
      await range.write({ command: "view", path: range.filePath }, range.ctx),
    );
    for (const restored of ["One", "Two", "Three", "Four", "Five"]) {
      expect(afterRangeRedo).toContain(restored);
    }
  });

  it("normalizes documentId away from the model-facing write surface", async () => {
    const documentId = "123e4567-e89b-12d3-a456-426614174999";
    const filePath = "chapter.md";
    const harness = createWriteToolHarness({ [documentId]: "Alpha" });
    const write = wiredWriteHandler({ documentId, filePath, core: harness.core });
    const ctx = toolContext();

    const initialView = String(await write({ command: "view", path: filePath }, ctx));
    const insert = String(await write({ command: "insert", path: filePath, content: "Beta" }, ctx));
    const updatedView = String(await write({ command: "view", path: filePath }, ctx));
    const missing = JSON.stringify(await write({ command: "view", path: "missing.md" }, ctx));

    expect(initialView).toContain("Alpha");
    expect(updatedView).toContain("Beta");
    expect([initialView, insert, updatedView, missing].join("\n")).not.toContain(documentId);
  });
});

async function seededWiredWrite() {
  const documentId = crypto.randomUUID();
  const filePath = "chapter.md";
  const harness = createWriteToolHarness({ [documentId]: "Alpha" });
  const write = wiredWriteHandler({ documentId, filePath, core: harness.core });
  const ctx = toolContext();

  await write({ command: "view", path: filePath }, ctx);
  for (const content of ["One", "Two", "Three", "Four", "Five"]) {
    await write({ command: "insert", path: filePath, content }, ctx);
  }
  return { write, filePath, ctx };
}

function wiredWriteHandler(input: { documentId: string; filePath: string; core: AgentEditCore }) {
  const port = contextPortFor(input.documentId, input.filePath);
  const [writeRegistration] = createWiredCoreToolRegistrations({
    threads: { findById: async () => thread() } as never,
    threadWorks: { findPrimary: async () => null, listByThread: async () => [] },
    contextPorts: { forProject: () => port, forWork: () => port },
    documentSync: {
      agentEdit: () => input.core,
      refreshDocumentProjection: async () => {},
    },
    responseWrites: { trackStagedCreate: () => {} },
    eventSink: createInMemoryEventSink(),
  });
  if (writeRegistration?.definition.name !== "write") {
    throw new Error("missing wired write registration");
  }
  if (writeRegistration.execution.type !== "server") throw new Error("write must be server-backed");
  return writeRegistration.execution.handler as TestWriteHandler;
}

function contextPortFor(documentId: string, filePath: string): ContextPort {
  return {
    stat: async (uri) =>
      uri === filePath
        ? {
            ok: true,
            value: {
              kind: "tracked",
              uri,
              documentId,
              filetype: "markdown",
              schemaType: "document",
            },
          }
        : { ok: false, error: { code: "not_found", uri } },
    ensureTrackedDocument: async (uri) => ({
      ok: true,
      value: { documentId, created: uri === filePath },
    }),
    delete: async () => ({ ok: true, value: undefined }),
    list: async () => ({ ok: true, value: [] }),
    search: async () => ({ ok: true, value: [] }),
    read: async () => ({ ok: false, error: { code: "not_found", uri: filePath } }),
    write: async () => ({ ok: false, error: { code: "invalid_operation", uri: filePath } }),
    edit: async () => ({ ok: false, error: { code: "invalid_operation", uri: filePath } }),
    writeBinary: async () => ({ ok: false, error: { code: "invalid_operation", uri: filePath } }),
    move: async () => ({ ok: false, error: { code: "invalid_operation", uri: filePath } }),
    mkdir: async () => ({ ok: true, value: undefined }),
  };
}

function toolContext(): ToolHandlerContext {
  return {
    signal: new AbortController().signal,
    threadId: "thread-a",
    turnId: "turn-a",
    agentSlug: null,
    toolCallId: undefined,
  };
}

function thread() {
  return {
    id: "thread-a",
    projectId: "project-a",
    workId: null,
    userId: "user-a",
    kind: "primary",
    status: "active",
    title: null,
    currentAgent: null,
    parentThreadId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
