/** Adapter coverage for manuscript assets and thread-attached upload images. */

import { describe, expect, it, vi } from "vitest";
import { createContextImageAssetAdapter } from "./context-image-assets.js";

const documentId = "11111111-1111-4111-8111-111111111111";
const context = { projectId: "project-1", threadId: "thread-1" };

function deps() {
  return {
    figures: {
      documentExistsForProject: vi.fn(),
      findDocumentFileForProject: vi.fn(),
    },
    uploads: {
      getUpload: vi.fn(),
      getDocument: vi.fn(),
    },
    objectStore: {
      getSignedUrl: vi.fn().mockResolvedValue({
        ok: true,
        value: "https://assets.example/signed",
      }),
    },
  };
}

describe("context image asset adapter", () => {
  it("resolves a manuscript image belonging to the project", async () => {
    const stubs = deps();
    stubs.figures.findDocumentFileForProject.mockResolvedValue({
      assetDocumentId: documentId,
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
    await expect(adapter.resolve(context, reference)).resolves.toEqual({
      mediaType: "image/png",
      data: new URL("https://assets.example/signed"),
    });
    expect(stubs.figures.findDocumentFileForProject).toHaveBeenCalledWith("project-1", documentId);
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
      })
      .mockResolvedValueOnce({
        storageUrl: "object://meridian/uploads/notes.pdf",
        mimeType: "application/pdf",
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
});
