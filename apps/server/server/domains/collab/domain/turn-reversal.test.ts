/** Unit coverage for turn-level reversal safety handoff. */
import type { ReversalStore } from "@meridian/agent-edit";
import { describe, expect, it } from "vitest";
import { reverseTurn } from "./turn-reversal.js";

describe("reverseTurn", () => {
  it("passes the checked live high-watermark into reversal persistence", async () => {
    expect.assertions(3);
    const outcome = await reverseTurn(
      {
        reversalStore: {
          documentsForTurn: async () => ["doc-a"],
        } as unknown as ReversalStore,
        agentEdit: {
          reverse: async (input) => {
            expect(input.commitGuard).toEqual({
              expectedLatestSeq: 42,
              failureStatus: "cant_undo_dependent",
              failureMessage:
                "This turn has later live edits depending on it. View the change instead of undoing it.",
            });
            return {
              command: "undo",
              status: "cant_undo_dependent",
              isError: true,
              text: "status: cant_undo_dependent\nInjected race row.",
            };
          },
        },
        resolveDocumentUri: async (documentId) => documentId,
        checkDependentLaterLiveRows: async () => ({
          hasDependents: false,
          checkedUntilSeq: 42,
        }),
      },
      {
        threadId: "thread-a" as never,
        turnId: "turn-a" as never,
        direction: "undo",
        actor: { type: "user", userId: "user-a" },
      },
    );

    expect(outcome.status).toBe("cant_undo_dependent");
    expect(outcome.documents).toEqual([
      expect.objectContaining({ uri: "doc-a", status: "cant_undo_dependent" }),
    ]);
  });
});
