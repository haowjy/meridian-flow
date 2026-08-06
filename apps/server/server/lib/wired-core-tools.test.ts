import type { AgentEditCore, ResponseCommitSuccessResult } from "@meridian/agent-edit/integration";
import { createWriteToolHarness } from "@meridian/agent-edit/test-support";
import { describe, expect, it, vi } from "vitest";
import { asThreadPeerAgentEditCore } from "../domains/collab/domain/agent-edit-cores.js";
import {
  type ContextPort,
  type ContextSchemeAdapter,
  createContextPortRouter,
} from "../domains/context/index.js";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import { createInMemoryProjectPreferencesRepository } from "../domains/preferences/index.js";
import { createInMemoryWorkRepository, WorkDeleteBlockedError } from "../domains/projects/index.js";
import type { ToolHandlerContext } from "../domains/runtime/index.js";
import { Ok } from "../shared/result.js";
import {
  createAgentEditResponseWriteLifecycle,
  createWiredCoreToolRegistrations,
} from "./wired-core-tools.js";

type TestWriteHandler = (input: unknown, ctx: ToolHandlerContext) => Promise<unknown>;

describe("wired work tool", () => {
  async function setup(kind: "primary" | "subagent" = "primary", draftMode = false) {
    const baseWorks = createInMemoryWorkRepository();
    const current = await baseWorks.create({
      id: "00000000-0000-4000-8000-000000000011",
      projectId: "project-1",
      createdByUserId: "user-1",
      name: "Current",
    });
    const target = await baseWorks.create({
      id: "00000000-0000-4000-8000-000000000012",
      projectId: "project-1",
      createdByUserId: "user-1",
      name: "Target",
    });
    const works = draftMode
      ? {
          ...baseWorks,
          async findById(id: string) {
            const work = await baseWorks.findById(id as never);
            return work && id === current.id ? { ...work, aiWriteMode: "draft" as const } : work;
          },
        }
      : baseWorks;
    let primaryWorkId = current.id;
    const invalidateThread = vi.fn(async () => {});
    const threadChanged = vi.fn(async () => {});
    const preferences = createInMemoryProjectPreferencesRepository();
    const registrations = createWiredCoreToolRegistrations({
      threads: {
        findById: async () =>
          ({
            id: "thread-1",
            projectId: "project-1",
            userId: "user-1",
            kind,
          }) as never,
        listByWork: async () => [
          {
            id: "recent-thread",
            title: "Revision chat",
            updatedAt: "2026-08-06T12:00:00.000Z",
            status: "active",
            composedSystemPrompt: "large frozen prompt",
          },
        ],
      } as never,
      threadWorks: {
        findPrimary: async () => ({ workId: primaryWorkId }),
        rebindPrimary: async (_threadId, workId) => {
          const previousWorkId = primaryWorkId;
          primaryWorkId = workId;
          return { previousWorkId, changed: previousWorkId !== workId };
        },
      },
      works: works as never,
      preferences,
      workContextUpdates: { projectChanged: async () => {}, threadChanged },
      drafts: { draftReview: { list: async () => [{ draftId: "draft-1" }] } } as never,
      contextPorts: {} as never,
      documentSync: {
        agentEdit: () => ({ invalidateThread }) as never,
      } as never,
      responseWrites: { trackStagedCreate: () => {} } as never,
      eventSink: createInMemoryEventSink(),
    });
    const registration = registrations.find((candidate) => candidate.definition.name === "work");
    if (registration?.execution.type !== "server") throw new Error("missing work");
    return {
      handler: registration.execution.handler as TestWriteHandler,
      current,
      target,
      works: baseWorks,
      preferences,
      invalidateThread,
      threadChanged,
    };
  }

  it("dispatches all six branches and journals mutation receipts", async () => {
    const { handler, target } = await setup();
    const ctx = toolContext();
    await expect(handler({ command: "list" }, ctx)).resolves.toHaveLength(2);
    await expect(handler({ command: "show", work: target.slug }, ctx)).resolves.toMatchObject({
      work: { slug: "target", name: "Target" },
      recentThreads: [
        {
          title: "Revision chat",
          updatedAt: "2026-08-06T12:00:00.000Z",
          status: "active",
        },
      ],
      drafts: [{ draftId: "draft-1" }],
    });
    await expect(handler({ command: "create", name: "New Work" }, ctx)).resolves.toMatchObject({
      metadata: { workReceipt: { category: "mutate", inverse: { command: "delete" } } },
    });
    await expect(
      handler({ command: "update", work: target.slug, goal: "" }, ctx),
    ).resolves.toMatchObject({
      output: { goal: null },
      metadata: { workReceipt: { inverse: { command: "update" } } },
    });
    await expect(handler({ command: "switch", work: target.slug }, ctx)).resolves.toMatchObject({
      metadata: { workReceipt: { category: "binding" } },
    });
    const created = (await handler({ command: "create", name: "Delete Me" }, ctx)) as {
      output: { slug: string };
    };
    await expect(
      handler({ command: "delete", work: created.output.slug }, ctx),
    ).resolves.toMatchObject({
      metadata: { workReceipt: { inverse: { command: "restore" } } },
    });

    const [listOutput, showOutput, switchResult] = await Promise.all([
      handler({ command: "list" }, ctx),
      handler({ command: "show", work: target.slug }, ctx),
      handler({ command: "switch", work: target.slug }, ctx),
    ]);
    const outputs = [listOutput, showOutput, (switchResult as { output: unknown }).output];
    expect(JSON.stringify(outputs)).not.toMatch(
      /00000000-0000-4000-8000-00000000001[12]|project-1|user-1|large frozen prompt/,
    );
  });

  it("returns actionable unknown-slug errors and rejects extra schema fields", async () => {
    const { handler } = await setup();
    await expect(
      handler({ command: "show", work: "missing" }, toolContext()),
    ).resolves.toMatchObject({
      isError: true,
      output: { code: "work_not_found", details: { validWorkSlugs: ["current", "target"] } },
    });
    await expect(
      handler({ command: "list", unexpected: true }, toolContext()),
    ).resolves.toMatchObject({ isError: true });
  });

  it("returns a coded delete refusal with the blocking content kind", async () => {
    const { handler, target, works } = await setup();
    vi.spyOn(works, "softDelete").mockRejectedValueOnce(new WorkDeleteBlockedError("documents"));
    await expect(
      handler({ command: "delete", work: target.slug }, toolContext()),
    ).resolves.toMatchObject({
      isError: true,
      output: {
        code: "work_delete_blocked",
        details: { blockingContentKind: "documents" },
      },
    });
  });

  it("marks changed switches for post-result delivery and only sticks primary switches", async () => {
    const primary = await setup("primary", true);
    await expect(
      primary.handler({ command: "switch", work: primary.target.slug }, toolContext()),
    ).resolves.toMatchObject({ metadata: { workContextChanged: true } });
    expect(primary.invalidateThread).not.toHaveBeenCalled();
    expect(primary.threadChanged).not.toHaveBeenCalled();
    await expect(primary.preferences.getCurrentWorkId("user-1", "project-1")).resolves.toBe(
      primary.target.id,
    );

    const subagent = await setup("subagent", false);
    await subagent.handler({ command: "switch", work: subagent.target.slug }, toolContext());
    expect(subagent.invalidateThread).not.toHaveBeenCalled();
    await expect(subagent.preferences.getCurrentWorkId("user-1", "project-1")).resolves.toBeNull();
  });

  it("keeps an already-current switch side-effect free beyond its receipt", async () => {
    const fixture = await setup();
    await fixture.handler({ command: "switch", work: fixture.target.slug }, toolContext());
    await expect(
      fixture.handler({ command: "switch", work: fixture.target.slug }, toolContext()),
    ).resolves.not.toMatchObject({ metadata: { workContextChanged: true } });
    expect(fixture.threadChanged).not.toHaveBeenCalled();
  });
});

function agentEditCoreWithCommit(commitResult: ResponseCommitSuccessResult): AgentEditCore {
  return {
    write: async () => ({
      command: "read",
      status: "success",
      phase: "committed",
      isError: false,
      text: "",
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
    }),
    redo: async () => ({
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

function noopResponseFinalizer() {
  return {
    finalizeResponseCommit: async () => ({
      status: "committed" as const,
      documents: [],
      stagedCreates: { committed: [], discarded: [] },
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
              content: [{ type: "text", text: "status: success\nwrite id: w1" }],
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
            content: [{ type: "text", text: "status: success\nwrite id: w1" }],
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

describe("wired write tool", () => {
  it("enforces reserved @ names through the model write path", async () => {
    const ensureTrackedDocument = vi.fn(async () =>
      Ok({ documentId: "00000000-0000-4000-8000-000000000031" }),
    );
    const adapter = {
      name: "scratch",
      capabilities: { writable: true, searchable: true, creatable: true },
      stat: async () => Ok(null),
      ensureTrackedDocument,
    } as unknown as ContextSchemeAdapter;
    const port = createContextPortRouter({ adapters: new Map([["scratch", adapter]]) });
    const write = wiredWriteHandler({
      documentId: "00000000-0000-4000-8000-000000000031",
      filePath: "scratch://notes/@evil.md",
      core: createWriteToolHarness({}).core,
      port,
    });

    await expect(
      write(
        { command: "create", path: "scratch://notes/@evil.md", content: "blocked" },
        toolContext(),
      ),
    ).resolves.toMatchObject({
      isError: true,
      output: { code: "tool_error" },
    });
    expect(ensureTrackedDocument).not.toHaveBeenCalled();
  });

  it("round-trips qualified ls and search result URIs directly into write read", async () => {
    const currentId = "00000000-0000-4000-8000-000000000021";
    const targetId = "00000000-0000-4000-8000-000000000022";
    const documentId = "00000000-0000-4000-8000-000000000023";
    const works = createInMemoryWorkRepository();
    await works.create({
      id: currentId,
      projectId: "project-a",
      createdByUserId: "user-a",
      name: "Current",
    });
    await works.create({
      id: targetId,
      projectId: "project-a",
      createdByUserId: "user-a",
      name: "Target",
    });
    const receivedUris: string[] = [];
    const port = {
      ...contextPortFor(documentId, "scratch://@target/notes.md"),
      stat: async (uri: string) => {
        receivedUris.push(uri);
        return {
          ok: true as const,
          value: {
            kind: "tracked" as const,
            uri,
            documentId,
            filetype: "markdown" as const,
            schemaType: "document" as const,
          },
        };
      },
      list: async () => ({
        ok: true as const,
        value: [
          {
            kind: "file" as const,
            uri: `scratch://${targetId}/notes.md`,
            documentId,
            editable: true as const,
            readonly: false,
            filetype: "markdown" as const,
            schemaType: "document" as const,
          },
        ],
      }),
      search: async () => ({
        ok: true as const,
        value: [
          {
            uri: `scratch://${targetId}/notes.md`,
            matches: [],
            matchCount: 1,
          },
        ],
      }),
    } satisfies ContextPort;
    const harness = createWriteToolHarness({ [documentId]: "Sibling notes" });
    const registrations = createWiredCoreToolRegistrations({
      threads: { findById: async () => thread() } as never,
      threadWorks: {
        findPrimary: async () => ({ workId: currentId }),
        rebindPrimary: async () => ({ previousWorkId: currentId, changed: false }),
      },
      works,
      preferences: {} as never,
      workContextUpdates: { projectChanged: async () => {}, threadChanged: async () => {} },
      drafts: { draftReview: { list: async () => [] } } as never,
      contextPorts: { forProject: () => port, forWork: () => port },
      documentSync: {
        agentEdit: () => asThreadPeerAgentEditCore(harness.core),
        refreshDocumentProjection: async () => {},
        ...noopResponseFinalizer(),
      },
      responseWrites: { trackStagedCreate: () => {} },
      eventSink: createInMemoryEventSink(),
    });
    const handler = (name: "write" | "ls" | "search") => {
      const registration = registrations.find((candidate) => candidate.definition.name === name);
      if (registration?.execution.type !== "server") throw new Error(`missing ${name}`);
      return registration.execution.handler as TestWriteHandler;
    };

    const listed = (await handler("ls")({ path: "scratch://@target" }, toolContext())) as Array<{
      uri: string;
    }>;
    const searched = (await handler("search")(
      { pattern: "notes", scope: "scratch://@target" },
      toolContext(),
    )) as Array<{ uri: string }>;
    expect(listed[0]?.uri).toBe("scratch://@target/notes.md");
    expect(searched[0]?.uri).toBe("scratch://@target/notes.md");
    await expect(
      writeText(handler("write"), { command: "read", path: listed[0]?.uri }, toolContext()),
    ).resolves.toContain("Sibling notes");
    await expect(
      writeText(handler("write"), { command: "read", path: searched[0]?.uri }, toolContext()),
    ).resolves.toContain("Sibling notes");
    expect(receivedUris).toEqual(["scratch://@target/notes.md", "scratch://@target/notes.md"]);
  });

  it("forwards undo and redo to/from selectors through the model-facing tool boundary", async () => {
    const single = await seededWiredWrite();

    await expect(
      writeText(single.write, { command: "undo", path: single.filePath, to: "w3" }, single.ctx),
    ).resolves.toContain("status: reversed");
    const afterSingleUndo = await writeText(
      single.write,
      { command: "read", path: single.filePath },
      single.ctx,
    );
    expect(afterSingleUndo).toContain("One");
    expect(afterSingleUndo).not.toContain("Three");

    await expect(
      writeText(single.write, { command: "redo", path: single.filePath, to: "w3" }, single.ctx),
    ).resolves.toContain("status: reconciled");
    expect(
      await writeText(single.write, { command: "read", path: single.filePath }, single.ctx),
    ).toContain("Three");

    const range = await seededWiredWrite();
    await expect(
      writeText(
        range.write,
        { command: "undo", path: range.filePath, from: "w2", to: "w5" },
        range.ctx,
      ),
    ).resolves.toContain("status: reversed");
    const afterRangeUndo = await writeText(
      range.write,
      { command: "read", path: range.filePath },
      range.ctx,
    );
    expect(afterRangeUndo).toContain("One");
    for (const removed of ["Two", "Three", "Four", "Five"]) {
      expect(afterRangeUndo).not.toContain(removed);
    }

    await expect(
      writeText(
        range.write,
        { command: "redo", path: range.filePath, from: "w2", to: "w5" },
        range.ctx,
      ),
    ).resolves.toContain("status: reconciled");
    const afterRangeRedo = await writeText(
      range.write,
      { command: "read", path: range.filePath },
      range.ctx,
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

    const initialRead = await writeText(write, { command: "read", path: filePath }, ctx);
    const insert = await writeText(
      write,
      { command: "insert", path: filePath, content: "Beta" },
      ctx,
    );
    const updatedRead = await writeText(write, { command: "read", path: filePath }, ctx);
    const missing = JSON.stringify(await write({ command: "read", path: "missing.md" }, ctx));

    expect(initialRead).toContain("Alpha");
    expect(updatedRead).toContain("Beta");
    expect([initialRead, insert, updatedRead, missing].join("\n")).not.toContain(documentId);
  });
});

async function writeText(
  write: TestWriteHandler,
  input: unknown,
  ctx: ToolHandlerContext,
): Promise<string> {
  return toolResultText(await write(input, ctx));
}

function toolResultText(result: unknown): string {
  const output =
    typeof result === "object" && result !== null && "output" in result
      ? (result as { output?: unknown }).output
      : result;
  if (Array.isArray(output)) {
    return output
      .map((block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : JSON.stringify(block),
      )
      .join("\n\n");
  }
  return String(output);
}

async function seededWiredWrite() {
  const documentId = crypto.randomUUID();
  const filePath = "chapter.md";
  const harness = createWriteToolHarness({ [documentId]: "Alpha" });
  const write = wiredWriteHandler({ documentId, filePath, core: harness.core });
  const ctx = toolContext();

  await write({ command: "read", path: filePath }, ctx);
  for (const content of ["One", "Two", "Three", "Four", "Five"]) {
    await write({ command: "insert", path: filePath, content }, ctx);
  }
  return { write, filePath, ctx };
}

function wiredWriteHandler(input: {
  documentId: string;
  filePath: string;
  core: AgentEditCore;
  port?: ContextPort;
}) {
  const port = input.port ?? contextPortFor(input.documentId, input.filePath);
  const [writeRegistration] = createWiredCoreToolRegistrations({
    threads: { findById: async () => thread() } as never,
    threadWorks: {
      findPrimary: async () => null,
      rebindPrimary: async () => ({ previousWorkId: null, changed: true }),
    },
    works: { listByProject: async () => [] } as never,
    preferences: {} as never,
    workContextUpdates: { projectChanged: async () => {}, threadChanged: async () => {} },
    drafts: { draftReview: { list: async () => [] } } as never,
    contextPorts: { forProject: () => port, forWork: () => port },
    documentSync: {
      agentEdit: () => asThreadPeerAgentEditCore(input.core),
      refreshDocumentProjection: async () => {},
      ...noopResponseFinalizer(),
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
    createTrackedDocument: async () => ({ ok: true, value: { documentId } }),
    createUntitledDocument: async () => ({
      ok: true,
      value: { status: "created", documentId, path: filePath, name: filePath },
    }),
    delete: async () => ({ ok: true, value: undefined }),
    list: async () => ({ ok: true, value: [] }),
    search: async () => ({ ok: true, value: [] }),
    read: async () => ({ ok: false, error: { code: "not_found", uri: filePath } }),
    write: async () => ({ ok: false, error: { code: "invalid_operation", uri: filePath } }),
    edit: async () => ({ ok: false, error: { code: "invalid_operation", uri: filePath } }),
    writeBinary: async () => ({ ok: false, error: { code: "invalid_operation", uri: filePath } }),
    move: async () => ({ ok: false, error: { code: "invalid_operation", uri: filePath } }),
    commitWriterLocation: async () => ({
      ok: false,
      error: { code: "invalid_operation", uri: filePath },
    }),
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
