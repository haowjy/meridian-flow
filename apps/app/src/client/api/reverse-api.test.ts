/**
 * Pins the restoredWorks seam: every read of the reverse endpoint's Work half
 * goes through it, so drift in the server's field or status naming must land
 * here as a parser fix, never as a silent "no Works restored".
 */
import type { ReversalOutcome } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { restoredWorks } from "./reverse-api";

function outcome(extra: Record<string, unknown>): ReversalOutcome {
  return { status: "nothing_to_undo", documents: [], ...extra } as ReversalOutcome;
}

describe("restoredWorks", () => {
  it("reads restored entries and prefers the writer-facing name", () => {
    expect(
      restoredWorks(
        outcome({
          workReceipts: [
            { command: "restore", workId: "w1", status: "restored" },
            { command: "restore", workId: "w2", name: "Side quests", status: "restored" },
          ],
        }),
      ),
    ).toEqual([{ name: null }, { name: "Side quests" }]);
  });

  it("skips entries the server did not report as restored", () => {
    expect(
      restoredWorks(
        outcome({
          workReceipts: [
            { command: "restore", workId: "w1", status: "not_found" },
            "garbage",
            null,
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("parses an outcome without a Work half as no restores", () => {
    expect(restoredWorks(outcome({}))).toEqual([]);
  });
});
