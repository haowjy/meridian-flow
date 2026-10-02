/** History navigation names the conversation a call resolved, even when the model said "current". */
import { expect, it } from "vitest";
import { threadHistoryPreview, threadLsHistoryPreview } from "./history-previews.js";

it("names the resolved conversation, never a report run", () => {
  expect(threadHistoryPreview({ ref: "p7" }, { ref: "p7", outcome: "succeeded" })).toBe("p7");
  expect(threadHistoryPreview({ ref: "current" }, { ref: "p2", status: "unavailable" })).toBe("p2");
  expect(threadHistoryPreview({ ref: "c1" })).toBe("c1");
  expect(threadHistoryPreview({ ref: "current" }, "Conversation c4\n\n[1] user")).toBe("c4");
  expect(threadHistoryPreview({}, "Conversation c4")).toBe("c4");
});

it("previews the explicit or resolved thread_ls target instead of the path root", () => {
  const output = "c1 › p2 (you)\np2  awake  Continuity check\n  p3  Child";
  expect(threadLsHistoryPreview({ ref: "p2" }, output)).toBe("p2");
  expect(threadLsHistoryPreview({ ref: "current" }, output)).toBe("p2");
  expect(threadLsHistoryPreview({}, output)).toBe("p2");
});
