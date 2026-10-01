/** Transcript rows: dividers become rows, R4 overflow shells never do. */
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

  it("keeps the reply open while its autocompaction runs, not while a manual one does", () => {
    const pendingAuto = compaction("c", "pending");
    expect(
      buildTranscriptModel([turn("u", "user"), turn("a", "assistant"), pendingAuto], false)
        .continuing,
    ).toEqual([false, true, false]);
    const pendingManual = turn("c", "compaction", {
      status: "pending",
      blocks: [],
      metadata: { trigger: "manual", controlMessageId: "k" },
    });
    expect(
      buildTranscriptModel([turn("u", "user"), turn("a", "assistant"), pendingManual], false)
        .continuing,
    ).toEqual([false, false, false]);
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
