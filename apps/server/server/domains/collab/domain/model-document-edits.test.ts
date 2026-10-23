/** Model edit history follows its immutable origins without requiring a current draft. */
import { describe, expect, it, vi } from "vitest";
import { createModelDocumentEdits } from "./model-document-edits.js";

describe("model document edit history", () => {
  it("reads archived-origin history when the current draft has not materialized the document", async () => {
    const modelEdits = vi.fn(async () => ({
      status: "success" as const,
      message: "e1  earlier turn  pending  none",
      actionId: "action",
      room: null,
    }));
    const edits = createModelDocumentEdits({
      service: () => ({ modelEdits }) as never,
      drafts: {
        resolveWorkDraftForThread: vi.fn(async () => {
          throw new Error("history must not resolve a missing current draft");
        }),
      } as never,
      coordinator: {} as never,
    });

    const result = await edits.read({
      documentId: "document",
      threadId: "thread",
      command: { command: "history", file: "manuscript://chapter", format: "edits" },
      context: { documentVersion: "draft", linkView: null },
    } as never);

    expect(result).toMatchObject({ status: "success", message: expect.stringContaining("e1") });
    expect(modelEdits).toHaveBeenCalledOnce();
  });
});
