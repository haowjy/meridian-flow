import { describe, expect, it } from "vitest";

import {
  filterThreadsByTitle,
  hasOtherThreadAttention,
  shouldShowThreadSearch,
} from "./thread-switcher";

describe("filterThreadsByTitle", () => {
  const threads = [
    { title: "Dragon's Ascent" },
    { title: "  Academy interlude  " },
    { title: null },
  ];

  it("matches trimmed titles without case sensitivity", () => {
    expect(filterThreadsByTitle(threads, "  ACADEMY ")).toEqual([threads[1]]);
  });

  it("returns every thread for a blank query", () => {
    expect(filterThreadsByTitle(threads, "   ")).toEqual(threads);
  });

  it("does not invent a searchable title for untitled threads", () => {
    expect(filterThreadsByTitle(threads, "new chat")).toEqual([]);
  });
});

describe("shouldShowThreadSearch", () => {
  it("shows search at the eight-thread threshold", () => {
    expect(shouldShowThreadSearch(7)).toBe(false);
    expect(shouldShowThreadSearch(8)).toBe(true);
  });
});

describe("hasOtherThreadAttention", () => {
  it("ignores attention on the active thread", () => {
    expect(
      hasOtherThreadAttention(
        [
          { id: "active", attention: "actionRequired" },
          { id: "other", attention: "none" },
        ],
        "active",
      ),
    ).toBe(false);
  });

  it("reports unread or action-required attention on another thread", () => {
    expect(
      hasOtherThreadAttention(
        [
          { id: "active", attention: "none" },
          { id: "other", attention: "unread" },
        ],
        "active",
      ),
    ).toBe(true);
  });
});
