/** Transcript rows: dividers become rows, undo markers and R4 overflow shells never do. */
import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { buildTranscriptModel } from "./transcript-model";

const turn = (id: string, role: string, extra: Record<string, unknown> = {}) =>
  ({ id, role, status: "complete", blocks: [{ id: `${id}-b` }], ...extra }) as unknown as Turn;
const compaction = (id: string, status = "complete") =>
  turn(id, "compaction", { status, blocks: [], metadata: { trigger: "auto" } });
const rows = (turns: Turn[]) =>
  buildTranscriptModel(turns, false).rows.map((row) => `${row.kind}:${row.turn.id}`);

describe("transcript rows", () => {
  it("renders a compaction turn as a divider row in place", () => {
    expect(rows([turn("u", "user"), turn("a", "assistant"), compaction("c")])).toEqual([
      "turn:u",
      "turn:a",
      "compaction:c",
    ]);
  });

  it("folds undo markers into the divider they name", () => {
    const undo = turn("undo", "system", {
      blocks: [{ id: "t", blockType: "text" }],
      metadata: { kind: "compaction_undo", revertsCompactionTurnId: "c" },
    });
    const model = buildTranscriptModel([turn("u", "user"), compaction("c"), undo], false);
    expect(model.rows.map((row) => row.turn.id)).toEqual(["u", "c"]);
    const divider = model.rows[1];
    expect(divider?.kind === "compaction" && divider.undo.undone?.id).toBe("undo");
  });

  it("hides the empty assistant turn the overflow fallback completed before C (R4)", () => {
    const shell = turn("a", "assistant", { blocks: [] });
    expect(
      rows([
        turn("u", "user"),
        shell,
        compaction("c"),
        turn("b", "assistant", { prevTurnId: "c" }),
      ]),
    ).toEqual(["turn:u", "compaction:c", "turn:b"]);
  });

  it("keeps a mid-response autocompaction inside one reply", () => {
    const model = buildTranscriptModel(
      [turn("u", "user"), turn("a", "assistant"), compaction("c"), turn("b", "assistant")],
      false,
    );
    // A continues across the divider into B: one action row, one Info scope.
    expect(model.continuing).toEqual([false, true, false, false]);
    expect(model.partsByFinalTurnId.get("b")?.map((part) => part.id)).toEqual(["a", "b"]);
  });

  it("ends a reply at a manual compaction with nothing after it", () => {
    const model = buildTranscriptModel(
      [turn("u", "user"), turn("a", "assistant"), compaction("c")],
      false,
    );
    expect(model.continuing).toEqual([false, false, false]);
    expect(model.partsByFinalTurnId.get("a")?.map((part) => part.id)).toEqual(["a"]);
  });

  it("does not attach delivery rows past a divider to the reply before it", () => {
    const notice = turn("n", "system", {
      prevTurnId: "c",
      blocks: [],
      metadata: { kind: "subagent_update", handle: "p1", outcome: "succeeded" },
    });
    const model = buildTranscriptModel(
      [turn("a", "assistant"), { ...compaction("c"), prevTurnId: "a" } as Turn, notice],
      false,
    );
    expect(model.deliveryEventsFor("a")).toEqual([]);
  });
});
