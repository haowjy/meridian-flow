/** History navigation names the conversation a call resolved, even when the model said "current". */
import { expect, it } from "vitest";
import {
  spawnHistoryPreview,
  threadHistoryPreview,
  threadLsHistoryPreview,
  writeHistoryPreview,
} from "./history-previews.js";

it("names the resolved conversation, never a report run", () => {
  expect(threadHistoryPreview({ ref: "p7" }, { ref: "p7", outcome: "succeeded" })).toBe("p7");
  expect(threadHistoryPreview({ ref: "current" }, { ref: "p2", status: "unavailable" })).toBe("p2");
  expect(threadHistoryPreview({ ref: "c1" })).toBe("c1");
  expect(threadHistoryPreview({ ref: "current" }, { ref: "c4", view: "page", turns: [] })).toBe(
    "c4",
  );
  // Rendered text is never parsed back (D43).
  expect(threadHistoryPreview({}, "Conversation c4")).toBe("current");
});

it("previews the explicit or resolved thread_ls target from its typed result", () => {
  const result = { ref: "p2", listing: "c1 › p2 (you)\np2  awake  Continuity check\n  p3  Child" };
  expect(threadLsHistoryPreview({ ref: "p2" }, result)).toBe("p2");
  expect(threadLsHistoryPreview({ ref: "current" }, result)).toBe("p2");
  expect(threadLsHistoryPreview({}, result)).toBe("p2");
});

it("previews a spawn by its handle and task name, and tolerates a pre-rename row", () => {
  expect(spawnHistoryPreview({ name: "Continuity check" }, { handle: "p4" })).toBe(
    '"Continuity check" → p4',
  );
  expect(spawnHistoryPreview({ description: "Old label" }, { handle: "p4" })).toBe('"" → p4');
});

it("names a copy's source next to its destination", () => {
  const written = { write: { id: "w2" } };
  expect(
    writeHistoryPreview(
      { command: "copy", path: "ch11-alt.md", from: { path: "ch11.md" } },
      written,
    ),
  ).toBe("copy ch11-alt.md from ch11.md, w2");
  expect(
    writeHistoryPreview({
      command: "insert",
      path: "ch12.md",
      from: { path: "ch11.md", in: [3, 5] },
    }),
  ).toBe("insert ch12.md from ch11.md");
});

it("says a write was drafted, as its receipt does", () => {
  const input = { command: "replace", path: "ch3.md", content: "Twelve words here." };
  expect(
    writeHistoryPreview(input, { write: { id: "w4" }, destination: "draft", draftWork: "rewrite" }),
  ).toBe("replace ch3.md, 3 words, w4 (drafted in @rewrite)");
  expect(writeHistoryPreview(input, { write: { id: "w4" }, destination: "live" })).toBe(
    "replace ch3.md, 3 words, w4",
  );
});
