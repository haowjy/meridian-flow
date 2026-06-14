import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../../observability/index.js";
import type { ObjectStorePort, ObjectStoreResult } from "../../../storage/index.js";
import { createObjectStorageUrl } from "../../../storage/object-storage-url.js";
import {
  createFigureAssetService,
  createInMemoryFigureDocumentRepository,
  type FigureDocumentRepository,
} from "../index.js";

class MemoryObjectStore implements ObjectStorePort {
  readonly objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  readonly deleted: string[] = [];

  async put(
    key: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<ObjectStoreResult<{ storageUrl: string }>> {
    this.objects.set(key, { bytes, mimeType });
    return { ok: true, value: { storageUrl: createObjectStorageUrl(key) } };
  }

  async get(key: string): Promise<ObjectStoreResult<{ bytes: Uint8Array; mimeType: string }>> {
    const stored = this.objects.get(key);
    return stored
      ? { ok: true, value: stored }
      : { ok: false, error: { code: "not_found", message: "missing" } };
  }

  async list(
    prefix: string,
  ): Promise<
    ObjectStoreResult<{ keys: Array<{ key: string; sizeBytes: number; mimeType?: string }> }>
  > {
    const keys = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, stored]) => ({
        key,
        sizeBytes: stored.bytes.byteLength,
        mimeType: stored.mimeType,
      }));
    return { ok: true, value: { keys } };
  }

  async getSignedUrl(key: string): Promise<ObjectStoreResult<string>> {
    return this.objects.has(key)
      ? { ok: true, value: `/signed/${key}` }
      : { ok: false, error: { code: "not_found", message: "missing" } };
  }

  async delete(key: string): Promise<ObjectStoreResult<void>> {
    this.deleted.push(key);
    this.objects.delete(key);
    return { ok: true, value: undefined };
  }
}

describe("createFigureAssetService", () => {
  it("stores bytes, updates the document file columns, and returns a stable MyST reference", async () => {
    const store = new MemoryObjectStore();
    const repo: FigureDocumentRepository = {
      async findDocumentFileForProject() {
        return null;
      },
      async attachDocumentFile(input) {
        return {
          documentId: input.documentId,
          storageUrl: input.storageUrl,
          mimeType: input.mimeType,
          fileType: input.fileType,
          sizeBytes: input.sizeBytes,
        };
      },
    };
    const service = createFigureAssetService({
      objectStore: store,
      documents: repo,
      generateId: () => "asset-1",
      signedUrlExpiresAt: () => "2026-06-04T12:15:00.000Z",
      eventSink: createInMemoryEventSink(),
    });

    const result = await service.uploadFigure({
      projectId: "project-1",
      documentId: "document-1",
      bytes: Buffer.from("png"),
      mimeType: "image/png",
      filename: "gel.png",
      alt: "Gel image",
      caption: "Dose-response gel.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.storageUrl).toBe(
      "object://meridian/figures/project-1/document-1/asset-1-gel.png",
    );
    expect(result.value.figure.src).toBe(result.value.storageUrl);
    expect(result.value.signedUrl).toBe("/signed/figures/project-1/document-1/asset-1-gel.png");
  });

  it("accepts generic image/webp MIME types", async () => {
    const store = new MemoryObjectStore();
    const repo: FigureDocumentRepository = {
      async findDocumentFileForProject() {
        return null;
      },
      async attachDocumentFile(input) {
        return {
          documentId: input.documentId,
          storageUrl: input.storageUrl,
          mimeType: input.mimeType,
          fileType: input.fileType,
          sizeBytes: input.sizeBytes,
        };
      },
    };
    const service = createFigureAssetService({
      objectStore: store,
      documents: repo,
      generateId: () => "asset-webp",
      signedUrlExpiresAt: () => "2026-06-04T12:15:00.000Z",
      eventSink: createInMemoryEventSink(),
    });

    const result = await service.uploadFigure({
      projectId: "project-1",
      documentId: "document-1",
      bytes: Buffer.from("webp"),
      mimeType: "image/webp",
      filename: "gel.webp",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.figure).toMatchObject({
      src: result.value.storageUrl,
    });
    expect(store.objects.size).toBe(1);
  });

  it("rejects unsupported MIME types before writing bytes", async () => {
    const store = new MemoryObjectStore();
    const repo: FigureDocumentRepository = {
      async findDocumentFileForProject() {
        return null;
      },
      async attachDocumentFile() {
        throw new Error("should not be called");
      },
    };
    const service = createFigureAssetService({
      objectStore: store,
      documents: repo,
      signedUrlExpiresAt: () => "2026-06-04T12:15:00.000Z",
      eventSink: createInMemoryEventSink(),
    });

    const result = await service.uploadFigure({
      projectId: "project-1",
      documentId: "document-1",
      bytes: Buffer.from("txt"),
      mimeType: "text/plain",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_mime_type");
    expect(store.objects.size).toBe(0);
  });

  it("round-trips through the in-memory figure document repository", async () => {
    const store = new MemoryObjectStore();
    const service = createFigureAssetService({
      objectStore: store,
      documents: createInMemoryFigureDocumentRepository(),
      generateId: () => "asset-1",
      signedUrlExpiresAt: () => "2026-06-04T12:15:00.000Z",
      eventSink: createInMemoryEventSink(),
    });

    const upload = await service.uploadFigure({
      projectId: "project-1",
      documentId: "document-1",
      bytes: Buffer.from("png"),
      mimeType: "image/png",
      filename: "gel.png",
    });

    expect(upload.ok).toBe(true);
    if (!upload.ok) return;

    const signedUrl = await service.getSignedFigureUrl({
      projectId: "project-1",
      documentId: "document-1",
    });

    expect(signedUrl.ok).toBe(true);
    if (!signedUrl.ok) return;
    expect(signedUrl.value).toMatchObject({
      documentId: "document-1",
      storageUrl: upload.value.storageUrl,
      mimeType: "image/png",
      fileType: "image",
      signedUrl: "/signed/figures/project-1/document-1/asset-1-gel.png",
    });
  });

  it("converts repository attach throws to an error and cleans up the newly written object", async () => {
    const store = new MemoryObjectStore();
    const repo: FigureDocumentRepository = {
      async findDocumentFileForProject() {
        return null;
      },
      async attachDocumentFile() {
        throw new Error("db unavailable");
      },
    };
    const service = createFigureAssetService({
      objectStore: store,
      documents: repo,
      generateId: () => "asset-1",
      signedUrlExpiresAt: () => "2026-06-04T12:15:00.000Z",
      eventSink: createInMemoryEventSink(),
    });

    const result = await service.uploadFigure({
      projectId: "project-1",
      documentId: "document-1",
      bytes: Buffer.from("png"),
      mimeType: "image/png",
      filename: "gel.png",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("repository_error");
    expect(store.deleted).toEqual(["figures/project-1/document-1/asset-1-gel.png"]);
    expect(store.objects.size).toBe(0);
  });

  it("returns a saved reference when signing fails after the document attach succeeds", async () => {
    const store = new MemoryObjectStore();
    store.getSignedUrl = async () => ({
      ok: false,
      error: { code: "io_error", message: "signing unavailable" },
    });
    const repo: FigureDocumentRepository = {
      async findDocumentFileForProject() {
        return null;
      },
      async attachDocumentFile(input) {
        return {
          documentId: input.documentId,
          storageUrl: input.storageUrl,
          mimeType: input.mimeType,
          fileType: input.fileType,
          sizeBytes: input.sizeBytes,
        };
      },
    };
    const service = createFigureAssetService({
      objectStore: store,
      documents: repo,
      generateId: () => "asset-1",
      signedUrlExpiresAt: () => "2026-06-04T12:15:00.000Z",
      eventSink: createInMemoryEventSink(),
    });

    const result = await service.uploadFigure({
      projectId: "project-1",
      documentId: "document-1",
      bytes: Buffer.from("png"),
      mimeType: "image/png",
      filename: "gel.png",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.storageUrl).toBe(
      "object://meridian/figures/project-1/document-1/asset-1-gel.png",
    );
    expect(result.value.signedUrl).toBe("");
    expect(result.value.signedUrlExpiresAt).toBe("1970-01-01T00:00:00.000Z");
    expect(store.objects.size).toBe(1);
  });
});
