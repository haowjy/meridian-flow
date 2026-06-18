/**
 * In-memory document sync facade tests: atomic editDocument parity with the
 * Drizzle facade under concurrent writers.
 */
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryDocumentSyncFacade } from "./document-sync-facade.js";

const USER = "00000000-0000-4000-8000-000000000303" as UserId;

describe("createInMemoryDocumentSyncFacade", () => {
  it("applies parallel facade edits without clobbering", async () => {
    const documentId = crypto.randomUUID() as DocumentId;
    const facade = createInMemoryDocumentSyncFacade({
      resolveDocumentProjection: () => ({
        markdown: "# Chapter\n\nBody and tail",
        filetype: "markdown",
      }),
    });

    await facade.writeDocument({
      documentId,
      markdown: "# Chapter\n\nBody and tail",
      origin: { type: "user", actorUserId: USER },
    });

    await Promise.all([
      facade.editDocument({
        documentId,
        transform: (markdown) => markdown.replace("Body", "Body a"),
        origin: { type: "user", actorUserId: USER },
      }),
      facade.editDocument({
        documentId,
        transform: (markdown) => markdown.replace("tail", "tail b"),
        origin: { type: "user", actorUserId: USER },
      }),
    ]);

    const read = await facade.readAsMarkdown(documentId);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toBe("# Chapter\n\nBody a and tail b\n");
    }
  });
});
