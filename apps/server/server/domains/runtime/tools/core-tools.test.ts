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
});
