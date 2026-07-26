/** Redo eligibility classifies only writer-authored rows as intervening edits. */
import { describe, expect, it } from "vitest";
import { InMemoryAgentEditJournal } from "../test-support/in-memory-agent-edit.js";
import { evaluateRedoEligibility } from "./reconstruction.js";

const update = (seq: number, origin: string, actorTurnId?: string) => ({
  seq,
  update: new Uint8Array([seq]),
  meta: { origin, ...(actorTurnId ? { actorTurnId } : {}), seq },
});

describe("evaluateRedoEligibility", () => {
  it.each([
    ["the undo row", update(2, "system")],
    ["system bookkeeping", update(3, "system", "turn-system")],
    ["delayed agent work", update(3, "agent:turn-later", "turn-later")],
  ])("allows %s after undo", (_label, later) => {
    expect(
      evaluateRedoEligibility([update(1, "agent:turn-target"), later], { undoUpdateSeq: 2 }),
    ).toEqual({
      ok: true,
    });
  });

  it("rejects a writer row after undo", () => {
    expect(
      evaluateRedoEligibility(
        [update(1, "agent:turn-target"), update(2, "system"), update(3, "human:user-1")],
        { undoUpdateSeq: 2 },
      ),
    ).toMatchObject({
      ok: false,
      reason: "forward_update_after_undo",
      blockingUpdateSeq: 3,
    });
  });

  it("enforces the plan watermark again when redo persists", async () => {
    const journal = new InMemoryAgentEditJournal();
    await journal.append("chapter.md", new Uint8Array([1]), {
      origin: "agent:turn-target",
      seq: 0,
    });
    await journal.persistUndo("chapter.md", new Uint8Array([2]), [
      {
        documentId: "chapter.md",
        threadId: "thread-1",
        turnId: "turn-target",
        writeIds: ["w1"],
        status: "reversed",
        undoUpdateSeq: 0,
      },
    ]);
    const [reversal] = await journal.readReversals("chapter.md");
    if (!reversal) throw new Error("missing reversal");
    await journal.append("chapter.md", new Uint8Array([3]), {
      origin: "human:user-1",
      seq: 0,
    });

    await expect(
      journal.persistRedoBatch("chapter.md", [
        {
          update: new Uint8Array([4]),
          ref: { threadId: "thread-1", undoUpdateSeq: reversal.undoUpdateSeq },
          meta: { origin: "system", seq: 0 },
          persistGuardWatermark: reversal.undoUpdateSeq,
        },
      ]),
    ).resolves.toEqual({ consumed: false });
  });
});
