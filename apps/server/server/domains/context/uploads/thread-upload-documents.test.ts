/**
 * Thread upload document read-path tests: persisted fileType is the source of
 * truth on getUpload/listRecent, matching Drizzle rows where binary uploads
 * have filetype null on documentYjsHeads.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "../../threads/index.js";
import { createInMemoryThreadUploadDocumentStore } from "./thread-upload-documents.js";

describe("thread upload document read path", () => {
  it("getUpload trusts persisted fileType when filetype is null (Drizzle binary shape)", async () => {
    const repos = createInMemoryRepositories();
    const store = createInMemoryThreadUploadDocumentStore(repos.threadDocuments);
    const documentId = "00000000-0000-4000-8000-000000000601";
    const threadId = "00000000-0000-4000-8000-000000000602";

    await store.createUploadDocument({
      id: documentId,
      projectId: "00000000-0000-4000-8000-000000000603",
      threadId,
      filename: "gel.png",
      name: "gel",
      extension: "png",
      filetype: null,
      mimeType: "image/png",
      sizeBytes: 3,
      markdownProjection: "",
      storageUrl: "object://meridian/uploads/project/thread/document/png",
    });
    await repos.threadDocuments.attach(threadId, documentId, "editing");

    const upload = await store.getUpload(threadId, documentId);
    expect(upload).toMatchObject({
      editable: false,
      filetype: null,
      fileType: "image",
      kind: "binary",
      mimeType: "image/png",
    });
  });

  it("listRecent trusts persisted fileType when filetype is null (Drizzle binary shape)", async () => {
    const repos = createInMemoryRepositories();
    const store = createInMemoryThreadUploadDocumentStore(repos.threadDocuments);
    const documentId = "00000000-0000-4000-8000-000000000611";
    const threadId = "00000000-0000-4000-8000-000000000612";
    const touchedAt = "2026-06-10T12:00:00.000Z";

    await store.createUploadDocument({
      id: documentId,
      projectId: "00000000-0000-4000-8000-000000000613",
      threadId,
      filename: "scan.pdf",
      name: "scan",
      extension: "pdf",
      filetype: null,
      mimeType: "application/pdf",
      sizeBytes: 9,
      markdownProjection: "",
      storageUrl: "object://meridian/uploads/project/thread/document/pdf",
    });

    const [recent] = await store.listRecent([
      {
        id: "00000000-0000-4000-8000-000000000614",
        turnId: "00000000-0000-4000-8000-000000000615",
        threadId,
        documentId,
        touchedAt,
      },
    ]);

    expect(recent).toMatchObject({
      editable: false,
      filetype: null,
      fileType: "pdf",
      kind: "binary",
      mimeType: "application/pdf",
      touchedAt,
    });
  });
});
