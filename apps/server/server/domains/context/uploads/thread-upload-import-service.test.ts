/**
 * Upload import service tests: verify thread upload classification, mirror
 * seeding, and object-storage cleanup.
 */

import { describe, expect, it } from "vitest";
import { createInMemoryDocumentStore } from "../../collab/adapters/in-memory/document-store.js";
import { createDocumentSyncService } from "../../collab/domain/document-sync-service.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createInMemoryObjectStore, type ObjectStorePort } from "../../storage/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import {
  createInMemoryThreadUploadDocumentStore,
  createThreadUploadImportService,
} from "./index.js";

function trackingObjectStore(): ObjectStorePort & { deletedKeys: string[] } {
  const inner = createInMemoryObjectStore();
  const deletedKeys: string[] = [];
  return {
    deletedKeys,
    put: (key, bytes, mimeType) => inner.put(key, bytes, mimeType),
    get: (key) => inner.get(key),
    list: (prefix, options) => inner.list(prefix, options),
    getSignedUrl: (key) => inner.getSignedUrl(key),
    async delete(key) {
      deletedKeys.push(key);
      return inner.delete(key);
    },
  };
}

describe("ThreadUploadImportService", () => {
  it.each([
    {
      filename: "scan.nii",
      mimeType: "application/octet-stream",
      id: "00000000-0000-4000-8000-000000000501",
    },
    {
      filename: "scan.nii.gz",
      mimeType: "application/gzip",
      id: "00000000-0000-4000-8000-000000000502",
    },
  ])("stores unknown non-text uploads as binary objects for $mimeType", async ({
    filename,
    mimeType,
    id,
  }) => {
    const repos = createInMemoryRepositories();
    const uploadDocuments = createInMemoryThreadUploadDocumentStore(repos.threadDocuments);
    const objectStore = createInMemoryObjectStore();
    const service = createThreadUploadImportService({
      repos,
      uploadDocuments,
      documentSync: createDocumentSyncService(createInMemoryDocumentStore()),
      objectStore,
      eventSink: createInMemoryEventSink(),
      generateId: () => id,
    });

    const result = await service.importUpload({
      workbenchId: "workbench_1",
      threadId: "thread_1",
      filename,
      bytes: new Uint8Array([0, 1, 2, 3]),
      mimeType,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        editable: false,
        kind: "binary",
        fileType: "binary",
        mimeType,
      },
    });
    const document = await uploadDocuments.getDocument(id);
    expect(document).toMatchObject({
      fileType: "binary",
      filetype: null,
      storageUrl: expect.stringContaining(`/uploads/workbench_1/thread_1/${id}/`),
    });
  });

  it("keeps blank-MIME Python uploads editable by falling back to filename", async () => {
    const repos = createInMemoryRepositories();
    const uploadDocuments = createInMemoryThreadUploadDocumentStore(repos.threadDocuments);
    const service = createThreadUploadImportService({
      repos,
      uploadDocuments,
      documentSync: createDocumentSyncService(createInMemoryDocumentStore()),
      objectStore: createInMemoryObjectStore(),
      eventSink: createInMemoryEventSink(),
      generateId: () => "00000000-0000-4000-8000-000000000503",
    });

    const result = await service.importUpload({
      workbenchId: "workbench_1",
      threadId: "thread_1",
      filename: "analysis.py",
      bytes: Buffer.from("print('hello')\n"),
      mimeType: "",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        editable: true,
        kind: "tracked",
        fileType: null,
        filetype: "python",
        mimeType: "",
      },
    });
    await expect(
      uploadDocuments.getDocument("00000000-0000-4000-8000-000000000503"),
    ).resolves.toMatchObject({ markdownProjection: "print('hello')\n" });
  });

  it.each([
    {
      filename: "pyproject.toml",
      bytes: Buffer.from("[project]\nname = 'demo'\n"),
      expectedProjection: "[project]\nname = 'demo'\n",
      id: "00000000-0000-4000-8000-000000000505",
    },
    {
      filename: "config.xml",
      bytes: Buffer.from("<config>ok</config>\n"),
      expectedProjection: "<config>ok</config>\n",
      id: "00000000-0000-4000-8000-000000000506",
    },
  ])("keeps blank-MIME $filename uploads editable through canonical path filetype rules", async ({
    filename,
    bytes,
    expectedProjection,
    id,
  }) => {
    const repos = createInMemoryRepositories();
    const uploadDocuments = createInMemoryThreadUploadDocumentStore(repos.threadDocuments);
    const service = createThreadUploadImportService({
      repos,
      uploadDocuments,
      documentSync: createDocumentSyncService(createInMemoryDocumentStore()),
      objectStore: createInMemoryObjectStore(),
      eventSink: createInMemoryEventSink(),
      generateId: () => id,
    });

    const result = await service.importUpload({
      workbenchId: "workbench_1",
      threadId: "thread_1",
      filename,
      bytes,
      mimeType: "",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        editable: true,
        kind: "tracked",
        fileType: null,
        filetype: "text",
        mimeType: "",
      },
    });
    await expect(uploadDocuments.getDocument(id)).resolves.toMatchObject({
      markdownProjection: expectedProjection,
    });
  });

  it("treats blank-MIME uploads containing NUL bytes as binary", async () => {
    const repos = createInMemoryRepositories();
    const uploadDocuments = createInMemoryThreadUploadDocumentStore(repos.threadDocuments);
    const service = createThreadUploadImportService({
      repos,
      uploadDocuments,
      documentSync: createDocumentSyncService(createInMemoryDocumentStore()),
      objectStore: createInMemoryObjectStore(),
      eventSink: createInMemoryEventSink(),
      generateId: () => "00000000-0000-4000-8000-000000000504",
    });

    const result = await service.importUpload({
      workbenchId: "workbench_1",
      threadId: "thread_1",
      filename: "analysis.py",
      bytes: new Uint8Array([112, 114, 105, 110, 116, 0, 10]),
      mimeType: "",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        editable: false,
        kind: "binary",
        fileType: "binary",
        mimeType: "",
      },
    });
  });

  it("persists binary storage classes from canonical filetype derivation", async () => {
    const repos = createInMemoryRepositories();
    const uploadDocuments = createInMemoryThreadUploadDocumentStore(repos.threadDocuments);
    const service = createThreadUploadImportService({
      repos,
      uploadDocuments,
      documentSync: createDocumentSyncService(createInMemoryDocumentStore()),
      objectStore: createInMemoryObjectStore(),
      eventSink: createInMemoryEventSink(),
      generateId: (() => {
        const ids = [
          "00000000-0000-4000-8000-000000000507",
          "00000000-0000-4000-8000-000000000508",
        ];
        return () => ids.shift() ?? "00000000-0000-4000-8000-000000000509";
      })(),
    });

    const image = await service.importUpload({
      workbenchId: "workbench_1",
      threadId: "thread_1",
      filename: "gel.png",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    });
    const docx = await service.importUpload({
      workbenchId: "workbench_1",
      threadId: "thread_1",
      filename: "protocol.docx",
      bytes: new Uint8Array([4, 5, 6]),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(image).toMatchObject({
      ok: true,
      value: { editable: false, kind: "binary", filetype: null, fileType: "image" },
    });
    expect(docx).toMatchObject({
      ok: true,
      value: { editable: false, kind: "binary", filetype: null, fileType: "docx" },
    });
  });

  it("rolls back the backing document and object bytes when a downstream attach fails", async () => {
    const repos = createInMemoryRepositories();
    const uploadDocuments = createInMemoryThreadUploadDocumentStore(repos.threadDocuments);
    const objectStore = trackingObjectStore();
    const service = createThreadUploadImportService({
      repos: {
        ...repos,
        threadDocuments: {
          ...repos.threadDocuments,
          attach: async () => {
            throw new Error("attach failed");
          },
        },
      },
      uploadDocuments,
      documentSync: createDocumentSyncService(createInMemoryDocumentStore()),
      objectStore,
      eventSink: createInMemoryEventSink(),
      generateId: () => "00000000-0000-4000-8000-000000000111",
    });

    const result = await service.importUpload({
      workbenchId: "project_1",
      threadId: "thread_1",
      filename: "figure.png",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "repository_error" } });
    expect(await uploadDocuments.getDocument("00000000-0000-4000-8000-000000000111")).toBeNull();
    expect(objectStore.deletedKeys).toEqual([
      "uploads/project_1/thread_1/00000000-0000-4000-8000-000000000111/png",
    ]);
  });

  it("rolls back the backing document when tracked mirror seeding fails", async () => {
    const repos = createInMemoryRepositories();
    const uploadDocuments = createInMemoryThreadUploadDocumentStore(repos.threadDocuments);
    const service = createThreadUploadImportService({
      repos,
      uploadDocuments,
      documentSync: {
        async getOrCreateMirror(documentId: string) {
          return { ok: false, error: { code: "corrupt_state", documentId, message: "bad doc" } };
        },
      } as never,
      objectStore: createInMemoryObjectStore(),
      eventSink: createInMemoryEventSink(),
      generateId: () => "00000000-0000-4000-8000-000000000222",
    });

    const result = await service.importUpload({
      workbenchId: "project_1",
      threadId: "thread_1",
      filename: "notes.md",
      bytes: Buffer.from("# Notes"),
      mimeType: "text/markdown",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "mirror_error" } });
    expect(await uploadDocuments.getDocument("00000000-0000-4000-8000-000000000222")).toBeNull();
  });

  it("evicts a tracked mirror when a downstream rollback happens after mirror seeding", async () => {
    const repos = createInMemoryRepositories();
    const uploadDocuments = createInMemoryThreadUploadDocumentStore(repos.threadDocuments);
    const forgotten: string[] = [];
    const service = createThreadUploadImportService({
      repos: {
        ...repos,
        threadDocuments: {
          ...repos.threadDocuments,
          attach: async () => {
            throw new Error("attach failed");
          },
        },
      },
      uploadDocuments,
      documentSync: {
        async getOrCreateMirror() {
          return { ok: true, value: "# Notes" };
        },
        forgetMirror(documentId: string) {
          forgotten.push(documentId);
        },
      } as never,
      objectStore: createInMemoryObjectStore(),
      eventSink: createInMemoryEventSink(),
      generateId: () => "00000000-0000-4000-8000-000000000444",
    });

    const result = await service.importUpload({
      workbenchId: "project_1",
      threadId: "thread_1",
      filename: "notes.md",
      bytes: Buffer.from("# Notes"),
      mimeType: "text/markdown",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "repository_error" } });
    expect(forgotten).toEqual(["00000000-0000-4000-8000-000000000444"]);
  });
});
