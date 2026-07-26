/** ContextFS-to-collab write routing and structured error coverage. */
import { describe, expect, it, vi } from "vitest";
import { DocumentMutationRejectedError } from "../../collab/domain/markdown-document.js";
import type { MarkdownDocumentStore } from "../../collab/index.js";
import { writeCollabMarkdown } from "./collab-document-sync.js";

describe("collab document sync", () => {
  it("surfaces write rejection as a ContextFS invalid operation", async () => {
    const writeDocument = vi.fn<MarkdownDocumentStore["writeDocument"]>(async () => {
      throw new DocumentMutationRejectedError({
        command: "create",
        status: "invalid_write",
        isError: true,
        text: "status: invalid_write",
      });
    });
    const documentSync = { writeDocument } as unknown as MarkdownDocumentStore;

    const result = await writeCollabMarkdown({
      documentSync,
      documentId: "document-1",
      content: "Replacement.",
      provenance: {
        type: "agent",
        agentSlug: "writer",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });

    expect(result).toEqual({ ok: false, error: { code: "invalid_operation" } });
    expect(writeDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: "document-1",
        origin: { type: "agent", actorTurnId: "turn-1" },
        threadId: "thread-1",
      }),
    );
  });
});
