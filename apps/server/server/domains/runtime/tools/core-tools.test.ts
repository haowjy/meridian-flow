/** Work tool input coverage for the fields the model may change. */
import { describe, expect, it } from "vitest";
import { WorkCommandSchema } from "./core-tools.js";

describe("WorkCommandSchema", () => {
  it("accepts a goal on create and update commands", () => {
    expect(
      WorkCommandSchema.safeParse({
        command: "create",
        name: "Arc",
        goal: "Reach the mirror",
      }).success,
    ).toBe(true);
    expect(
      WorkCommandSchema.safeParse({
        command: "update",
        work: "arc",
        goal: "Find the way through",
      }).success,
    ).toBe(true);
  });

  it("accepts explicit archive lifecycle commands and bounds free-text status", () => {
    expect(WorkCommandSchema.safeParse({ command: "archive", work: "arc" }).success).toBe(true);
    expect(WorkCommandSchema.safeParse({ command: "unarchive", work: "arc" }).success).toBe(true);
    expect(
      WorkCommandSchema.safeParse({ command: "update", work: "arc", status: "x".repeat(32) })
        .success,
    ).toBe(true);
    expect(
      WorkCommandSchema.safeParse({ command: "update", work: "arc", status: "x".repeat(33) })
        .success,
    ).toBe(false);
    expect(
      WorkCommandSchema.safeParse({ command: "update", work: "arc", status: "one two three four" })
        .success,
    ).toBe(false);
    expect(WorkCommandSchema.safeParse({ command: "list", archived: true }).success).toBe(true);
  });
});
