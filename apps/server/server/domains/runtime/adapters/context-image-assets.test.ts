/** Adapter coverage for manuscript assets and thread-attached upload images. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { LocalObjectStoreAdapter } from "../../storage/index.js";
import { createContextImageAssetAdapter } from "./context-image-assets.js";

const documentId = "11111111-1111-4111-8111-111111111111";
const context = { projectId: "project-1", threadId: "thread-1" };

function deps() {
  return {
    figures: {
      documentExistsForProject: vi.fn(),
      findDocumentFileForProject: vi.fn(),
      findManuscriptAssetForProject: vi.fn(),
    },
    uploads: {
      getUpload: vi.fn(),
      getDocument: vi.fn(),
    },
    objectStore: {
      get: vi.fn().mockResolvedValue({
        ok: true,
        value: { bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" },
      }),
    },
    eventSink: createInMemoryEventSink(),
  };
}

describe("context image asset adapter", () => {
  it("resolves a manuscript image belonging to the project", async () => {
    const stubs = deps();
    stubs.figures.findManuscriptAssetForProject.mockResolvedValue({
      assetDocumentId: documentId,
      assetPath: "assets/map.png",
      storageUrl: "object://meridian/figures/map.png",
      mimeType: "image/png",
      fileType: "image",
      sizeBytes: 123,
    });
    const adapter = createContextImageAssetAdapter(stubs as never);
    const reference = {
      type: "image_reference" as const,
      documentId,
      uri: "manuscript://assets/map.png",
    };

    await expect(adapter.isValidReference(context, reference)).resolves.toBe(true);
    await expect(adapter.resolve(context, reference, { maxBytes: 1024 })).resolves.toEqual({
      mediaType: "image/png",
      data: "AQID",
      sizeBytes: 3,
    });
    expect(stubs.figures.findManuscriptAssetForProject).toHaveBeenCalledWith(
      "project-1",
      documentId,
    );
  });

  it("does not let an upload masquerade as a project manuscript asset", async () => {
    const stubs = deps();
    stubs.figures.findManuscriptAssetForProject.mockResolvedValue(null);
    stubs.uploads.getUpload.mockResolvedValue({ documentId });
    const adapter = createContextImageAssetAdapter(stubs as never);

    await expect(
      adapter.isValidReference(context, {
        type: "image_reference",
        documentId,
        uri: "manuscript://assets/stolen.png",
      }),
    ).resolves.toBe(false);
    expect(stubs.uploads.getUpload).not.toHaveBeenCalled();
  });

  it("requires upload attachment to the current thread", async () => {
    const stubs = deps();
    stubs.uploads.getUpload.mockResolvedValue(null);
    const adapter = createContextImageAssetAdapter(stubs as never);
    const reference = {
      type: "image_reference" as const,
      documentId,
      uri: "uploads://22222222-2222-4222-8222-222222222222/map.png",
    };

    await expect(adapter.isValidReference(context, reference)).resolves.toBe(false);
    expect(stubs.uploads.getDocument).not.toHaveBeenCalled();
  });

  it("resolves an attached image upload and rejects non-image uploads", async () => {
    const stubs = deps();
    stubs.uploads.getUpload.mockResolvedValue({ documentId });
    stubs.uploads.getDocument
      .mockResolvedValueOnce({
        storageUrl: "object://meridian/uploads/map.png",
        mimeType: "image/webp",
        projectId: "project-1",
        uploadUri: "uploads://22222222-2222-4222-8222-222222222222/map.webp",
      })
      .mockResolvedValueOnce({
        storageUrl: "object://meridian/uploads/notes.pdf",
        mimeType: "application/pdf",
        projectId: "project-1",
        uploadUri: "uploads://22222222-2222-4222-8222-222222222222/map.webp",
      });
    const adapter = createContextImageAssetAdapter(stubs as never);
    const reference = {
      type: "image_reference" as const,
      documentId,
      uri: "uploads://22222222-2222-4222-8222-222222222222/map.webp",
    };

    await expect(adapter.isValidReference(context, reference)).resolves.toBe(true);
    await expect(adapter.isValidReference(context, reference)).resolves.toBe(false);
  });

  it("requires an upload reference to spell the document's authoritative Work URI", async () => {
    const stubs = deps();
    stubs.uploads.getUpload.mockResolvedValue({ documentId });
    stubs.uploads.getDocument.mockResolvedValue({
      storageUrl: "object://meridian/uploads/map.png",
      mimeType: "image/png",
      projectId: "project-1",
      uploadUri: "uploads://33333333-3333-4333-8333-333333333333/map.png",
    });
    const adapter = createContextImageAssetAdapter(stubs as never);

    await expect(
      adapter.isValidReference(context, {
        type: "image_reference",
        documentId,
        uri: "uploads://22222222-2222-4222-8222-222222222222/map.png",
      }),
    ).resolves.toBe(false);
  });

  it("resolves bytes from the real local object store", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "meridian-image-assets-"));
    try {
      const objectStore = new LocalObjectStoreAdapter({
        rootDir,
        signedUrlBasePath: "/api/objects",
        signingSecret: "test-secret",
        signedUrlTtlSeconds: 60,
      });
      const stored = await objectStore.put(
        "figures/map.png",
        Uint8Array.from([1, 2, 3]),
        "image/png",
      );
      if (!stored.ok) throw new Error(stored.error.message);
      const stubs = deps();
      stubs.figures.findManuscriptAssetForProject.mockResolvedValue({
        assetDocumentId: documentId,
        assetPath: "assets/map.png",
        storageUrl: stored.value.storageUrl,
        mimeType: "image/png",
        fileType: "image",
        sizeBytes: 3,
      });
      const adapter = createContextImageAssetAdapter({
        figures: stubs.figures as never,
        uploads: stubs.uploads as never,
        objectStore,
        eventSink: createInMemoryEventSink(),
      });

      await expect(
        adapter.resolve(
          context,
          {
            type: "image_reference",
            documentId,
            uri: "manuscript://assets/map.png",
          },
          { maxBytes: 1024 },
        ),
      ).resolves.toEqual({ mediaType: "image/png", data: "AQID", sizeBytes: 3 });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("emits diagnostics for operational object-store failures while degrading", async () => {
    const stubs = deps();
    stubs.figures.findManuscriptAssetForProject.mockResolvedValue({
      assetDocumentId: documentId,
      assetPath: "assets/map.png",
      storageUrl: "object://meridian/figures/map.png",
      mimeType: "image/png",
      fileType: "image",
      sizeBytes: 3,
    });
    stubs.objectStore.get.mockResolvedValue({
      ok: false,
      error: { code: "io_error", message: "storage unavailable" },
    });
    const adapter = createContextImageAssetAdapter(stubs as never);

    await expect(
      adapter.resolve(
        context,
        { type: "image_reference", documentId, uri: "manuscript://assets/map.png" },
        { maxBytes: 1024 },
      ),
    ).resolves.toBeNull();
    expect(stubs.eventSink.events).toEqual([
      expect.objectContaining({
        source: "runtime.image-assets",
        name: "object_read.failed",
      }),
    ]);
  });
});
