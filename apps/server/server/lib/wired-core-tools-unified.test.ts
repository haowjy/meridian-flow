/**
 * Wired core tools: unified manuscript:// routing through contextPortForThread.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryContextPortFactory,
  createInMemoryUnifiedContextPortFactory,
} from "../domains/context/index.js";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import { createInMemoryWorkRepository } from "../domains/projects/index.js";
import {
  createToolExecutor,
  createToolRegistry,
  REQUIRED_MANUSCRIPT_URI,
} from "../domains/runtime/index.js";
import { createInMemoryRepositories } from "../domains/threads/adapters/in-memory/index.js";
import { createWiredCoreToolRegistrations, UNIFIED_MANUSCRIPT_URI } from "./wired-core-tools.js";

describe("unified manuscript routing in wired-core-tools", () => {
  it("routes manuscript:// writes through the unified context port", async () => {
    const works = createInMemoryWorkRepository();
    const repos = createInMemoryRepositories({ works });
    const thread = await repos.threads.create({ userId: "user_1", projectId: "project_1" });
    const work = await works.create({
      projectId: "project_1",
      createdByUserId: "user_1",
      title: "Book 1",
    });
    await repos.threadWorks.addMembership(thread.id, work.id, true);
    const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });

    const unifiedFactory = createInMemoryUnifiedContextPortFactory();
    const executor = createToolExecutor(
      createToolRegistry({
        registrations: createWiredCoreToolRegistrations({
          threads: repos.threads,
          contextPorts: createInMemoryContextPortFactory(),
          unifiedContextPorts: unifiedFactory,
          threadWorks: repos.threadWorks,
          eventSink: createInMemoryEventSink(),
        }),
      }),
    );

    const result = await executor.executeTool(
      {
        id: "call-write-unified-manuscript",
        name: "write",
        arguments: { path: UNIFIED_MANUSCRIPT_URI, content: "unified chapter" },
      },
      {
        signal: new AbortController().signal,
        threadId: thread.id,
        turnId: turn.id,
        agentSlug: "writer",
      },
    );

    expect(result).toEqual({
      toolCallId: "call-write-unified-manuscript",
      output: {
        path: UNIFIED_MANUSCRIPT_URI,
        bytesWritten: Buffer.byteLength("unified chapter", "utf8"),
      },
    });

    const port = unifiedFactory.forWork(work.id, "project_1", "user_1", new Set([work.id]));
    const read = await port.read(UNIFIED_MANUSCRIPT_URI);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("unified chapter");
  });

  it("keeps legacy work://manuscript/ on the thread-scoped legacy port", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({ userId: "user_1", projectId: "project_1" });
    const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });
    let legacyWriteCalled = false;

    const portFactory = {
      forProject: createInMemoryContextPortFactory().forProject,
      forThread() {
        return {
          async readDocument(uri: string) {
            return { documentId: "doc-1", uri, markdown: "" };
          },
          async writeDocument() {
            legacyWriteCalled = true;
            return {
              documentId: "doc-1",
              uri: REQUIRED_MANUSCRIPT_URI,
              markdown: "legacy",
              updateSeq: 1,
            };
          },
          async editDocument() {
            throw new Error("not expected");
          },
        };
      },
    };

    const executor = createToolExecutor(
      createToolRegistry({
        registrations: createWiredCoreToolRegistrations({
          threads: repos.threads,
          contextPorts: portFactory,
          unifiedContextPorts: createInMemoryUnifiedContextPortFactory(),
          threadWorks: repos.threadWorks,
          eventSink: createInMemoryEventSink(),
        }),
      }),
    );

    await executor.executeTool(
      {
        id: "call-write-legacy",
        name: "write",
        arguments: { path: REQUIRED_MANUSCRIPT_URI, content: "legacy chapter" },
      },
      {
        signal: new AbortController().signal,
        threadId: thread.id,
        turnId: turn.id,
        agentSlug: "writer",
      },
    );

    expect(legacyWriteCalled).toBe(true);
    expect(UNIFIED_MANUSCRIPT_URI).toBe("manuscript://chapter-1.md");
  });

  it("routes list and search through the unified port for unified vocabulary URIs", async () => {
    const works = createInMemoryWorkRepository();
    const repos = createInMemoryRepositories({ works });
    const thread = await repos.threads.create({ userId: "user_1", projectId: "project_1" });
    const work = await works.create({
      projectId: "project_1",
      createdByUserId: "user_1",
      title: "Book 1",
    });
    await repos.threadWorks.addMembership(thread.id, work.id, true);

    const unifiedFactory = createInMemoryUnifiedContextPortFactory();
    const port = unifiedFactory.forWork(work.id, "project_1", "user_1", new Set([work.id]));
    await port.write("manuscript://chapter-1.md", "needle in manuscript", {
      origin: { type: "system" },
    });
    await port.write("kb://protocols/blot.md", "western blot needle", {
      origin: { type: "system" },
    });

    const executor = createToolExecutor(
      createToolRegistry({
        registrations: createWiredCoreToolRegistrations({
          threads: repos.threads,
          contextPorts: createInMemoryContextPortFactory(),
          unifiedContextPorts: unifiedFactory,
          threadWorks: repos.threadWorks,
          eventSink: createInMemoryEventSink(),
        }),
      }),
    );

    const listResult = await executor.executeTool(
      { id: "call-list", name: "list", arguments: { path: "manuscript://" } },
      {
        signal: new AbortController().signal,
        threadId: thread.id,
        turnId: "00000000-0000-4000-8000-000000000002",
        agentSlug: null,
      },
    );
    expect(listResult).toEqual({
      toolCallId: "call-list",
      output: expect.arrayContaining([
        expect.objectContaining({ uri: "manuscript://chapter-1.md" }),
      ]),
    });

    const searchResult = await executor.executeTool(
      { id: "call-search", name: "search", arguments: { query: "needle", uri: "kb://" } },
      {
        signal: new AbortController().signal,
        threadId: thread.id,
        turnId: "00000000-0000-4000-8000-000000000002",
        agentSlug: null,
      },
    );
    expect(searchResult).toEqual({
      toolCallId: "call-search",
      output: [
        expect.objectContaining({
          uri: "kb://protocols/blot.md",
          excerpt: expect.stringContaining("needle"),
        }),
      ],
    });
  });
});
