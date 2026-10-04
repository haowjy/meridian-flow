/** What follows a finished call's arrow in history, read from its typed result (D48). */
import { expect, it } from "vitest";
import {
  spawnHistorySummary,
  threadHistorySummary,
  workHistorySummary,
} from "./history-summaries.js";

it("names the conversation a thread tool resolved only when the call didn't", () => {
  expect(threadHistorySummary({ ref: "p7" }, { ref: "p7", outcome: "succeeded" })).toBeUndefined();
  expect(threadHistorySummary({ ref: "current" }, { ref: "p2", status: "unavailable" })).toBe("p2");
  expect(threadHistorySummary({}, { ref: "c4", view: "page", turns: [] })).toBe("c4");
  // Rendered text is never parsed back (D43).
  expect(threadHistorySummary({}, "Conversation c4")).toBeUndefined();
});

it("summarizes a spawn or message by the child's handle", () => {
  expect(spawnHistorySummary({}, { status: "completed", report: { handle: "p9" } })).toBe("p9");
  expect(spawnHistorySummary({}, "text")).toBeUndefined();
});

it("summarizes a Work listing by its size and a create or switch by the Work it landed in", () => {
  expect(workHistorySummary({ command: "list" }, [{ slug: "a" }, { slug: "b" }])).toBe("2 Works");
  expect(workHistorySummary({ command: "switch", target: "arc" }, { slug: "arc" })).toBe("@arc");
  expect(workHistorySummary({ command: "switch" }, { slug: null })).toBe("@/");
  expect(workHistorySummary({ command: "update", work: "arc" }, { slug: "arc" })).toBeUndefined();
});
