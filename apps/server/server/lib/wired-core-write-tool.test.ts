/** Context and URI write wiring protocol coverage. */
import type { AgentEditCore } from "@meridian/agent-edit/integration";
import { createWriteToolHarness } from "@meridian/agent-edit/test-support";
import { describe, expect, it, vi } from "vitest";
import { asThreadPeerAgentEditCore } from "../domains/collab/domain/agent-edit-cores.js";
import {
  type ContextPort,
  type ContextSchemeAdapter,
  createContextPortRouter,
} from "../domains/context/index.js";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import { createInMemoryWorkRepository } from "../domains/projects/index.js";
import type { ToolHandlerContext } from "../domains/runtime/index.js";
import { Ok } from "../shared/result.js";
import {
  createAgentEditResponseWriteLifecycle,
  createWiredCoreToolRegistrations,
} from "./wired-core-tools.js";

type TestWriteHandler = (input: unknown, ctx: ToolHandlerContext) => Promise<unknown>;
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
describe("wired write tool", () => {
  it("does not delete a replacement that occupies a discarded staged-create path", async () => {
    const stagedDocumentId = "00000000-0000-4000-8000-000000000041";
    const replacementDocumentId = "00000000-0000-4000-8000-000000000042";
    const path = "manuscript://chapter.md";
    let occupant: string | null = stagedDocumentId;
    const port = {
      ...contextPortFor(stagedDocumentId, path),
      delete: vi.fn(async (_uri: string, options) => {
        if (occupant === stagedDocumentId) occupant = replacementDocumentId;
        if (
          !occupant ||
          (options.expected.kind === "file" && options.expected.documentId !== occupant)
        ) {
          return { ok: false as const, error: { code: "stale_target" as const, uri: path } };
        }
        const deletedDocumentId = occupant;
        occupant = null;
        return Ok({ status: "deleted" as const, deletedDocumentIds: [deletedDocumentId] });
      }),
    } satisfies ContextPort;
    const lifecycle = createAgentEditResponseWriteLifecycle({
      documentSync: {
        ...noopResponseFinalizer(),
        finalizeResponseRollback: async () => ({
          stagedCreates: { committed: [], discarded: [stagedDocumentId] },
        }),
      } as never,
    });
    lifecycle.trackStagedCreate({
      responseId: "response-a",
      documentId: stagedDocumentId,
      path,
      port,
    });

    await lifecycle.rollbackResponse("response-a", { threadId: "thread-a", turnId: "turn-a" });

    expect(occupant).toBe(replacementDocumentId);
    expect(port.delete).toHaveBeenCalledWith(path, {
      expected: { kind: "file", documentId: stagedDocumentId },
    });
  });

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
      output: {
        schema: "meridian.agent-edit.v1",
        command: "create",
        status: "invalid_write",
      },
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
        if (uri.endsWith("/missing.md")) {
          return {
            ok: false as const,
            error: { code: "not_found" as const, uri: `scratch://${targetId}/missing.md` },
          };
        }
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
      workContextDelivery: {
        projectChanged: async () => {},
      },
      obligations: { enqueueThread: async (threadId) => [threadId] },
      drafts: { draftReview: { list: async () => [] } } as never,
      contextPorts: { forProject: () => port, forWork: () => port },
      documentSync: {
        agentEdit: () => asThreadPeerAgentEditCore(harness.core),
        refreshDocumentProjection: async () => {},
        ...noopResponseFinalizer(),
      },
      responseWrites: { trackStagedCreate: () => {} },
      eventSink: createInMemoryEventSink(),
      transaction: async (operation) => operation(),
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
    await expect(
      handler("write")({ command: "read", path: "scratch://@target/missing.md" }, toolContext()),
    ).resolves.toMatchObject({
      isError: true,
      output: {
        schema: "meridian.agent-edit.v1",
        command: "read",
        status: "document_not_found",
        message: "not_found: scratch://@target/missing.md",
      },
    });
    expect(receivedUris).toEqual([
      "scratch://@target/notes.md",
      "scratch://@target/notes.md",
      "scratch://@target/missing.md",
    ]);
  });

  it("keeps boundary failures in the versioned write result contract", async () => {
    const documentId = crypto.randomUUID();
    const filePath = "chapter.md";
    const write = wiredWriteHandler({
      documentId,
      filePath,
      core: createWriteToolHarness({ [documentId]: "Alpha" }).core,
    });
    const ctx = toolContext();

    await expect(write(null, ctx)).resolves.toMatchObject({
      isError: true,
      output: {
        schema: "meridian.agent-edit.v1",
        command: "unknown",
        status: "invalid_write",
        message: "write input must be an object",
      },
    });
    await expect(write({ command: "read", path: "missing.md" }, ctx)).resolves.toMatchObject({
      isError: true,
      output: {
        schema: "meridian.agent-edit.v1",
        command: "read",
        status: "document_not_found",
      },
    });
    await expect(write({ command: "diff" }, ctx)).resolves.toMatchObject({
      isError: true,
      output: {
        schema: "meridian.agent-edit.v1",
        command: "diff",
        status: "invalid_write",
        message: "Turn diff queries are not available in this host.",
      },
    });
  });

  it("forwards undo and redo to/from selectors through the model-facing tool boundary", async () => {
    const single = await seededWiredWrite();

    await expect(
      writeText(single.write, { command: "undo", path: single.filePath, to: "w3" }, single.ctx),
    ).resolves.toContain('"status":"reversed"');
    const afterSingleUndo = await writeText(
      single.write,
      { command: "read", path: single.filePath },
      single.ctx,
    );
    expect(afterSingleUndo).toContain("One");
    expect(afterSingleUndo).not.toContain("Three");

    await expect(
      writeText(single.write, { command: "redo", path: single.filePath, to: "w3" }, single.ctx),
    ).resolves.toContain('"status":"reconciled"');
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
    ).resolves.toContain('"status":"reversed"');
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
    ).resolves.toContain('"status":"reconciled"');
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
  return typeof output === "string" ? output : JSON.stringify(output);
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
    workContextDelivery: {
      projectChanged: async () => {},
    },
    obligations: { enqueueThread: async (threadId) => [threadId] },
    drafts: { draftReview: { list: async () => [] } } as never,
    contextPorts: { forProject: () => port, forWork: () => port },
    documentSync: {
      agentEdit: () => asThreadPeerAgentEditCore(input.core),
      refreshDocumentProjection: async () => {},
      ...noopResponseFinalizer(),
    },
    responseWrites: { trackStagedCreate: () => {} },
    eventSink: createInMemoryEventSink(),
    transaction: async (operation) => operation(),
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
    delete: async () => ({
      ok: true,
      value: { status: "deleted", deletedDocumentIds: [documentId] },
    }),
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
