/** Boundary tests for the explicit thread-rename command. */
import { describe, expect, it } from "vitest";
import { renameThreadRequestSchema, THREAD_TITLE_MAX_LENGTH } from "./rename-thread.js";

describe("renameThreadRequestSchema", () => {
  it("trims and keeps a writer-authored title", () => {
    expect(renameThreadRequestSchema.parse({ title: "  New title  " })).toEqual({
      title: "New title",
    });
  });

  it("accepts a title at the length cap", () => {
    const title = "x".repeat(THREAD_TITLE_MAX_LENGTH);
    expect(renameThreadRequestSchema.parse({ title })).toEqual({ title });
  });

  it.each([
    {},
    { title: "" },
    { title: "   " },
    { title: "x".repeat(THREAD_TITLE_MAX_LENGTH + 1) },
    { title: "New title", isFavorite: true },
  ])("rejects a body that is not exactly one non-empty title %#", (body) =>
    expect(renameThreadRequestSchema.safeParse(body).success).toBe(false));
});
