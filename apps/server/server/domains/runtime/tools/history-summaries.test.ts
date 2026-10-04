/** What follows a finished call's arrow in history, read from its typed result (D48). */
import { modelResult } from "@meridian/agent-edit";
import type { JsonValue } from "@meridian/contracts/threads";
import { expect, it } from "vitest";
import {
  documentHistorySummary,
  spawnHistorySummary,
  threadHistorySummary,
  workHistorySummary,
} from "./history-summaries.js";

it("summarizes a read by its block count", () => {
  const result = modelResult({
    command: "read",
    status: "success",
    phase: "committed",
    payload: {
      read: { format: "outline", documentBlocks: 62 },
      blocks: [
        {
          extent: "full",
          relation: "document",
          items: Array.from({ length: 5 }, (_, i) => ({ hash: `h${i}`, body: "x" })),
        },
      ],
    },
  }) as unknown as JsonValue;
  expect(documentHistorySummary({ path: "a.md", format: "outline" }, result)).toBe(
    "5 of 62 blocks",
  );
});

it("summarizes a write by its handle, the words it sent and where it drafted", () => {
  const result = modelResult({
    command: "replace",
    status: "success",
    phase: "committed",
    payload: { write: { id: "w4" }, destination: "draft", draftWork: "rewrite" },
  }) as unknown as JsonValue;
  expect(
    documentHistorySummary(
      { command: "replace", path: "ch3.md", find: "x", content: "Three short words." },
      result,
    ),
  ).toBe("w4, 3 words, version: draft (@rewrite)");
  expect(documentHistorySummary({ command: "replace" }, "plain text output")).toBeUndefined();
});

it("names the conversation a thread tool resolved only when the call didn't", () => {
  expect(threadHistorySummary({ ref: "p7" }, { ref: "p7", outcome: "succeeded" })).toBeUndefined();
  expect(threadHistorySummary({ ref: "current" }, { ref: "p2", status: "unavailable" })).toBe("p2");
  expect(threadHistorySummary({}, { ref: "c4", view: "page", turns: [] })).toBe("c4");
  // Rendered text is never parsed back (D43).
  expect(threadHistorySummary({}, "Conversation c4")).toBeUndefined();
});

it("summarizes a spawn or message by the child's handle", () => {
  expect(spawnHistorySummary({}, { status: "background", handle: "p8" })).toBe("p8");
  expect(spawnHistorySummary({}, { status: "completed", report: { handle: "p9" } })).toBe("p9");
  expect(spawnHistorySummary({}, "text")).toBeUndefined();
});

it("summarizes a Work listing by its size and a create or switch by the Work it landed in", () => {
  expect(workHistorySummary({ command: "list" }, [{ slug: "a" }, { slug: "b" }])).toBe("2 Works");
  expect(workHistorySummary({ command: "list" }, [{ slug: "a" }])).toBe("1 Work");
  expect(workHistorySummary({ command: "create", name: "Rewrite" }, { slug: "rewrite" })).toBe(
    "@rewrite",
  );
  expect(workHistorySummary({ command: "switch", target: "arc" }, { slug: "arc" })).toBe("@arc");
  expect(workHistorySummary({ command: "switch" }, { slug: null })).toBe("@/");
  expect(workHistorySummary({ command: "update", work: "arc" }, { slug: "arc" })).toBeUndefined();
});
