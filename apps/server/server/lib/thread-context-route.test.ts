/**
 * Thread context route tests: human writes carry thread scope and return persisted
 * write metadata from the unified ContextPort.
 */
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import type { ContextPort, ContextWriteOptions } from "../domains/context/ports/context-port.js";
import type { UnifiedContextPortFactory } from "../domains/context/unified-context-port-factory.js";
import { createInMemoryProjectRepository } from "../domains/projects/index.js";
import { createInMemoryRepositories } from "../domains/threads/adapters/in-memory/index.js";
import { writeThreadContextDocument } from "./thread-context-route.js";

class RecordingContextPort implements ContextPort {
  lastWriteOptions: ContextWriteOptions | undefined;

  async stat() {
    return { ok: false as const, error: { code: "not_found" as const, uri: "x" } };
  }

  async read() {
    return { ok: true as const, value: { content: "" } };
  }

  async write(_uri: string, _content: string, options?: ContextWriteOptions) {
    this.lastWriteOptions = options;
    return {
      ok: true as const,
      value: {
        documentId: "doc-1",
        markdown: "canonical markdown",
        updateSeq: 42,
      },
    };
  }

  async edit() {
    return { ok: true as const, value: { documentId: "doc-1" } };
  }

  async writeBinary() {
    return { ok: true as const, value: {} };
  }

  async list() {
    return { ok: true as const, value: [] };
  }

  async mkdir() {
    return { ok: true as const, value: undefined };
  }

  async search() {
    return { ok: true as const, value: [] };
  }

  async move() {
    return { ok: true as const, value: {} };
  }

  async delete() {
    return { ok: true as const, value: undefined };
  }
}

function factoryFor(port: ContextPort): UnifiedContextPortFactory {
  return {
    forProject: () => port,
    forWork: () => port,
  };
}

describe("writeThreadContextDocument", () => {
  it("passes threadId in human provenance and returns persisted write metadata", async () => {
    const port = new RecordingContextPort();
    const userId = "00000000-0000-4000-8000-000000000002" as UserId;
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId, title: "Project" });
    const repos = createInMemoryRepositories({ projects });
    const thread = await repos.threads.create({ userId, projectId: project.id });
    const threadId = thread.id as ThreadId;

    const response = await writeThreadContextDocument(
      {
        contextPorts: factoryFor(port),
        threads: repos.threads,
        threadWorks: repos.threadWorks,
      },
      {
        threadId,
        userId,
        uri: "manuscript://chapter-1.md",
        markdown: "request markdown",
      },
    );

    expect(port.lastWriteOptions).toEqual({
      origin: { type: "human", userId, threadId },
    });
    expect(response).toEqual({
      documentId: "doc-1",
      uri: "manuscript://chapter-1.md",
      markdown: "canonical markdown",
      updateSeq: 42,
    });
  });
});
