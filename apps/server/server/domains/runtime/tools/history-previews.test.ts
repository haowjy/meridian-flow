/** History navigation points at the saved execution even when the caller asked for latest. */
import { expect, it } from "vitest";
import {
  spawnHistoryPreview,
  threadHistoryPreview,
  threadLsHistoryPreview,
} from "./history-previews.js";

it("includes the resolved report run when the input omitted it", () => {
  expect(threadHistoryPreview({ ref: "p7" }, { ref: "p7", run: 3 })).toBe("p7 run 3");
  expect(threadHistoryPreview({ ref: "p7", run: 2 }, { run: 2 })).toBe("p7 run 2");
  expect(threadHistoryPreview({ ref: "c1" })).toBe("c1");
  expect(threadHistoryPreview({ ref: "current" }, "c4 (Agent: General)")).toBe("c4");
});

it("previews the explicit or resolved thread_ls target instead of the path root", () => {
  const output = "c1 › p2 (you)\np2  awake  Continuity check\n  p3  Child";
  expect(threadLsHistoryPreview({ ref: "p2" }, output)).toBe("p2");
  expect(threadLsHistoryPreview({ ref: "current" }, output)).toBe("p2");
  expect(threadLsHistoryPreview({}, output)).toBe("p2");
});

it("previews a spawn by its handle and task name, and tolerates a pre-rename row", () => {
  expect(spawnHistoryPreview({ name: "Continuity check" }, { handle: "p4" })).toBe(
    '→ p4 "Continuity check"',
  );
  expect(spawnHistoryPreview({ description: "Old label" }, { handle: "p4" })).toBe('→ p4 ""');
});
