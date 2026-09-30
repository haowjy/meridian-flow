/** History navigation points at the saved execution even when the caller asked for latest. */
import { expect, it } from "vitest";
import { threadHistoryPreview } from "./history-previews.js";

it("includes the resolved report run when the input omitted it", () => {
  expect(threadHistoryPreview({ ref: "p7" }, { ref: "p7", run: 3 })).toBe("p7 run 3");
  expect(threadHistoryPreview({ ref: "p7", run: 2 }, { run: 2 })).toBe("p7 run 2");
  expect(threadHistoryPreview({ ref: "c1" })).toBe("c1");
  expect(threadHistoryPreview({ ref: "current" }, "c4 (Agent: General)")).toBe("c4");
});
