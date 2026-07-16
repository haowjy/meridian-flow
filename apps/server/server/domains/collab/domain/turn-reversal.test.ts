/** Unit coverage for turn-level reversal safety handoff. */
import type { ReversalStore } from "@meridian/agent-edit";
import { describe, expect, it } from "vitest";
import { aggregateStatus, reverseTurn } from "./turn-reversal.js";

describe("reverseTurn", () => {
  it("leaves the advisory dependency precheck to agents while users reach the intrinsic guard", async () => {
    let userReverseCalled = false;
    const base = {
      reversalStore: {
        documentsForTurn: async () => ["doc-a"],
      } as unknown as ReversalStore,
      agentEdit: {
        reverse: async () => {
          userReverseCalled = true;
          return {
            command: "undo" as const,
            status: "cant_undo_dependent" as const,
            isError: true,
            text: "status: cant_undo_dependent",
          };
        },
      },
      resolveDocumentUri: async (documentId: string) => documentId,
      checkDependentLaterLiveRows: async () => ({ hasDependents: true, checkedUntilSeq: 42 }),
    };

    const user = await reverseTurn(base, {
      threadId: "thread-a" as never,
      turnId: "turn-a" as never,
      direction: "undo",
      actor: { type: "user", userId: "user-a" },
    });
    expect(userReverseCalled).toBe(true);
    expect(user.status).toBe("cant_undo_dependent");

    userReverseCalled = false;
    const agent = await reverseTurn(base, {
      threadId: "thread-a" as never,
      turnId: "turn-a" as never,
      direction: "undo",
      actor: { type: "agent" },
    });
    expect(userReverseCalled).toBe(false);
    expect(agent.status).toBe("cant_undo_dependent");
  });

  it("aggregates reconciled document outcomes as successful", () => {
    expect(aggregateStatus("undo", [{ status: "reconciled" }, { status: "reversed" }])).toBe(
      "reconciled",
    );
  });

  it("surfaces cant_undo_dependent from reversal persistence without a caller commit guard", async () => {
    expect.assertions(3);
    const outcome = await reverseTurn(
      {
        reversalStore: {
          documentsForTurn: async () => ["doc-a"],
        } as unknown as ReversalStore,
        agentEdit: {
          reverse: async (input) => {
            expect(input).not.toHaveProperty("commitGuard");
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
