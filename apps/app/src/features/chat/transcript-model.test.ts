/** Response grouping across a write-mode divider. */
import type { Turn } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { buildTranscriptModel } from "./transcript-model";

function turn(id: string, role: Turn["role"], extra: Partial<Turn> = {}): Turn {
  return {
    id,
    threadId: "t",
    position: 0,
    role,
    status: "complete",
    blocks: [],
    metadata: null,
    ...extra,
  } as unknown as Turn;
}

it("never groups a reply across a write-mode divider, even after a steer", () => {
  const turns = [
    turn("a", "assistant"),
    // Sent before the switch was queued, so the server stamped it a steer.
    turn("m", "user", { metadata: { delivery: "steer" } }),
    turn("sw", "system", { metadata: { kind: "write_mode_switch", mode: "direct" } }),
    turn("b", "assistant"),
  ];
  const model = buildTranscriptModel(turns, false);
  expect(model.rows.map((row) => row.kind)).toEqual(["turn", "turn", "write-mode", "turn"]);
  expect(model.continuing).toEqual([true, false, false, false]);
  expect(model.partsByFinalTurnId.get("a")?.map((part) => part.id)).toEqual(["a"]);
  expect(model.partsByFinalTurnId.get("b")?.map((part) => part.id)).toEqual(["b"]);
});
