/** Where a Retry stand-in sits among the stored turns the snapshot already holds. */
import type { Turn } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { placeStandIns } from "./retry-stand-ins";

function turn(id: string, role: Turn["role"], prevTurnId: string | null, extra = {}): Turn {
  return { id, role, prevTurnId, status: "complete", blocks: [], ...extra } as unknown as Turn;
}

const failed = turn("f", "assistant", "u", { status: "error" });
const modeSwitch = turn("s", "system", "f", {
  metadata: { kind: "write_mode_switch", mode: "draft", controlMessageId: "c1" },
});
const retry = turn("r", "assistant", "f", { status: "pending" });

it("places a Retry stand-in after the switch a partial snapshot holds, but before a newer message", () => {
  // The server commits the queued switch before it reserves the Retry's reply.
  const ids = (turns: Turn[]) => turns.map((t) => t.id);
  expect(ids(placeStandIns([failed, modeSwitch], [retry]))).toEqual(["f", "s", "r"]);
  const newer = turn("n", "user", "s");
  expect(ids(placeStandIns([failed, modeSwitch, newer], [retry]))).toEqual(["f", "s", "r", "n"]);
  expect(ids(placeStandIns([failed, newer], [retry]))).toEqual(["f", "r", "n"]);
});
