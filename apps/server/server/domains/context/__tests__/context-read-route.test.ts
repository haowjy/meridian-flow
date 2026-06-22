import { describe, expect, it } from "vitest";
import {
  handleContextReadRequest,
  resolveContextReadPath,
} from "../../../lib/context-read-route.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import {
  createInMemoryProjectRepository,
  createInMemoryWorkRepository,
} from "../../projects/index.js";
import {
  createInMemoryObjectStore,
  createObjectStorageUrl,
  type ObjectStorePort,
} from "../../storage/index.js";
import type { ContextPort, FileRef } from "../ports/context-port.js";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function contextFactoryFor(port: ContextPort): UnifiedContextPortFactory {
  return {
    forProject: (_projectId: string, _userId: string) => port,
    forWork: () => port,
  };
}

class TestContextPort implements ContextPort {
  readonly statCalls: string[] = [];
  readonly listCalls: string[] = [];
  readonly readCalls: string[] = [];
  private readonly files = new Map<string, FileRef>();
  private readonly contentByUri = new Map<string, string>();

  addFile(file: FileRef, content?: string): void {
    this.files.set(file.uri, file);
    if (content !== undefined) this.contentByUri.set(file.uri, content);
  }

  async stat(uri: string) {
    this.statCalls.push(uri);
    const file = this.files.get(uri);
    if (!file) return { ok: false as const, error: { code: "not_found" as const, uri } };
    return ok(file);
  }

  async read(uri: string) {
    this.readCalls.push(uri);
    const content = this.contentByUri.get(uri);
    if (content === undefined)
      return { ok: false as const, error: { code: "not_found" as const, uri } };
    return ok({ content });
  }

  async write() {
    return ok({});
  }

  async ensureTrackedDocument() {
    return ok({ documentId: "doc-1", created: false });
  }

  async edit() {
    return ok({});
  }

  async writeBinary() {
    return ok({});
  }

  async list(uri: string) {
    this.listCalls.push(uri);
    return ok([]);
  }

  async mkdir() {
    return ok(undefined);
  }

  async search() {
    return ok([]);
  }

  async move() {
    return ok({});
  }

  async delete() {
    return ok(undefined);
  }
}

async function expectHttpStatus(operation: Promise<unknown>, statusCode: number): Promise<void> {
  await expect(operation).rejects.toMatchObject({ statusCode });
}

async function expectHttpError(
  operation: Promise<unknown>,
  expected: { statusCode: number; message: string },
): Promise<void> {
  await expect(operation).rejects.toMatchObject(expected);
}

describe("context read route core", () => {
  it("normalizes uri-or-path query values under the route scheme", () => {
    expect(resolveContextReadPath("kb", "kb://notes/README.MD")).toMatchObject({
      uri: "kb://notes/README.MD",
      path: "/notes/README.MD",
    });
    expect(resolveContextReadPath("work", "/drafts/a.py", "work-1")).toMatchObject({
      uri: "work://work-1/drafts/a.py",
      path: "/drafts/a.py",
    });
    expect(resolveContextReadPath("manuscript", "/chapter-1.md")).toMatchObject({
      uri: "manuscript://chapter-1.md",
      path: "/chapter-1.md",
    });
  });

  it("returns tracked content with schema and language metadata", async () => {
    const projectRepo = createInMemoryProjectRepository();
    await projectRepo.create({ id: "project-1", userId: "user-1" });
    const port = new TestContextPort();
    port.addFile(
      {
        kind: "tracked",
        uri: "kb://notes/analysis.py",
        documentId: "doc-1",
        filetype: "python",
        schemaType: "code",
      },
      "x = 1",
    );

    const response = await handleContextReadRequest(
      {
        projectRepo,
        workRepo: createInMemoryWorkRepository(),
        contextPorts: contextFactoryFor(port),
        objectStore: createInMemoryObjectStore(),
        eventSink: createInMemoryEventSink(),
      },
      { projectId: "project-1", userId: "user-1", scheme: "kb", rawPath: "/notes/analysis.py" },
    );

    expect(response).toEqual({
      kind: "tracked",
      path: "/notes/analysis.py",
      content: "x = 1",
      schemaType: "code",
      filetype: "python",
    });
    expect(port.statCalls).toEqual(["kb://notes/analysis.py"]);
    expect(port.listCalls).toEqual([]);
    expect(port.readCalls).toEqual(["kb://notes/analysis.py"]);
  });

  it("returns tracked extensionless content with markdown defaults", async () => {
    const projectRepo = createInMemoryProjectRepository();
    await projectRepo.create({ id: "project-1", userId: "user-1" });
    const port = new TestContextPort();
    port.addFile(
      {
        kind: "tracked",
        uri: "kb://wefwef",
        documentId: "doc-1",
        filetype: "markdown",
        schemaType: "document",
      },
      "# Notes",
    );

    const response = await handleContextReadRequest(
      {
        projectRepo,
        workRepo: createInMemoryWorkRepository(),
        contextPorts: contextFactoryFor(port),
        objectStore: createInMemoryObjectStore(),
        eventSink: createInMemoryEventSink(),
      },
      { projectId: "project-1", userId: "user-1", scheme: "kb", rawPath: "/wefwef" },
    );

    expect(response).toEqual({
      kind: "tracked",
      path: "/wefwef",
      content: "# Notes",
      schemaType: "document",
      filetype: "markdown",
    });
  });

  it("returns tracked unknown-extension content from stored markdown classification", async () => {
    const projectRepo = createInMemoryProjectRepository();
    await projectRepo.create({ id: "project-1", userId: "user-1" });
    const port = new TestContextPort();
    port.addFile(
      {
        kind: "tracked",
        uri: "kb://notes.wef",
        documentId: "doc-1",
        filetype: "markdown",
        schemaType: "document",
      },
      "# Notes",
    );

    const response = await handleContextReadRequest(
      {
        projectRepo,
        workRepo: createInMemoryWorkRepository(),
        contextPorts: contextFactoryFor(port),
        objectStore: createInMemoryObjectStore(),
        eventSink: createInMemoryEventSink(),
      },
      { projectId: "project-1", userId: "user-1", scheme: "kb", rawPath: "/notes.wef" },
    );

    expect(response).toEqual({
      kind: "tracked",
      path: "/notes.wef",
      content: "# Notes",
      schemaType: "document",
      filetype: "markdown",
    });
  });

  it("returns a signed URL for non-tracked storage-backed files", async () => {
    const projectRepo = createInMemoryProjectRepository();
    await projectRepo.create({ id: "project-1", userId: "user-1" });
    const objectStore = createInMemoryObjectStore();
    const put = await objectStore.put(
      "context/project-1/data/report.pdf",
      Buffer.from("%PDF"),
      "application/pdf",
    );
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    const port = new TestContextPort();
    port.addFile({
      kind: "binary",
      uri: "user://data/report.pdf",
      documentId: "doc-2",
      fileType: "pdf",
      storageUrl: put.value.storageUrl,
      mimeType: "application/pdf",
    });

    const response = await handleContextReadRequest(
      {
        projectRepo,
        workRepo: createInMemoryWorkRepository(),
        contextPorts: contextFactoryFor(port),
        objectStore,
        eventSink: createInMemoryEventSink(),
      },
      {
        projectId: "project-1",
        userId: "user-1",
        scheme: "user",
        rawPath: "user://data/report.pdf",
      },
    );

    expect(response).toEqual({
      kind: "binary",
      path: "/data/report.pdf",
      url: "/memory-object-store/context%2Fproject-1%2Fdata%2Freport.pdf",
      fileType: "pdf",
      mimeType: "application/pdf",
    });
    expect(port.readCalls).toEqual([]);
  });

  it("404s when the requested path does not resolve to a file", async () => {
    const projectRepo = createInMemoryProjectRepository();
    await projectRepo.create({ id: "project-1", userId: "user-1" });
    const port = new TestContextPort();

    await expectHttpStatus(
      handleContextReadRequest(
        {
          projectRepo,
          workRepo: createInMemoryWorkRepository(),
          contextPorts: contextFactoryFor(port),
          objectStore: createInMemoryObjectStore(),
          eventSink: createInMemoryEventSink(),
        },
        { projectId: "project-1", userId: "user-1", scheme: "kb", rawPath: "/missing.md" },
      ),
      404,
    );
  });

  it("rejects non-owner access before touching context storage", async () => {
    const projectRepo = createInMemoryProjectRepository();
    await projectRepo.create({ id: "project-1", userId: "owner" });
    const port = new TestContextPort();

    await expectHttpStatus(
      handleContextReadRequest(
        {
          projectRepo,
          workRepo: createInMemoryWorkRepository(),
          contextPorts: contextFactoryFor(port),
          objectStore: createInMemoryObjectStore(),
          eventSink: createInMemoryEventSink(),
        },
        {
          projectId: "project-1",
          userId: "intruder",
          scheme: "kb",
          rawPath: "/notes/readme.md",
        },
      ),
      404,
    );
    expect(port.listCalls).toEqual([]);
    expect(port.statCalls).toEqual([]);
    expect(port.readCalls).toEqual([]);
  });

  it("surfaces missing object bytes as a clean 404 for binary files", async () => {
    const projectRepo = createInMemoryProjectRepository();
    await projectRepo.create({ id: "project-1", userId: "user-1" });
    const port = new TestContextPort();
    port.addFile({
      kind: "binary",
      uri: "kb://ghost.pdf",
      documentId: "doc-3",
      fileType: "pdf",
      storageUrl: createObjectStorageUrl("context/project-1/ghost.pdf"),
      mimeType: "application/pdf",
    });

    await expectHttpStatus(
      handleContextReadRequest(
        {
          projectRepo,
          workRepo: createInMemoryWorkRepository(),
          contextPorts: contextFactoryFor(port),
          objectStore: createInMemoryObjectStore(),
          eventSink: createInMemoryEventSink(),
        },
        { projectId: "project-1", userId: "user-1", scheme: "kb", rawPath: "/ghost.pdf" },
      ),
      404,
    );
  });

  it("collapses non-404 signed URL failures to a generic 502", async () => {
    const projectRepo = createInMemoryProjectRepository();
    await projectRepo.create({ id: "project-1", userId: "user-1" });
    const port = new TestContextPort();
    port.addFile({
      kind: "binary",
      uri: "kb://secret.pdf",
      documentId: "doc-4",
      fileType: "pdf",
      storageUrl: createObjectStorageUrl("context/project-1/secret.pdf"),
      mimeType: "application/pdf",
    });
    const objectStore: ObjectStorePort = {
      put: async () => ({
        ok: true,
        value: { storageUrl: createObjectStorageUrl("unused") },
      }),
      get: async () => ({ ok: false, error: { code: "not_found", message: "missing" } }),
      list: async () => ({ ok: true, value: { keys: [] } }),
      getSignedUrl: async () => ({
        ok: false,
        error: { code: "io_error", message: "provider leaked bucket/key details" },
      }),
      delete: async () => ({ ok: true, value: undefined }),
    };

    await expectHttpError(
      handleContextReadRequest(
        {
          projectRepo,
          workRepo: createInMemoryWorkRepository(),
          contextPorts: contextFactoryFor(port),
          objectStore,
          eventSink: createInMemoryEventSink(),
        },
        { projectId: "project-1", userId: "user-1", scheme: "kb", rawPath: "/secret.pdf" },
      ),
      { statusCode: 502, message: "Failed to resolve context file URL" },
    );
  });
});
