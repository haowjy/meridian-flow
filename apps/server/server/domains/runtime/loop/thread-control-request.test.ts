/** The control route's request shape: one discriminated union over every control kind.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Strict thread-control request grammar
 */
import { describe, expect, it } from "vitest";
import { threadControlRequestSchema } from "./thread-control-request.js";

const id = "6f1d1c9e-6c5b-4a43-9d36-6a3c5d1f2b7a";

describe("threadControlRequestSchema", () => {
  it("accepts a write-mode switch and normalizes compact instructions", () => {
    expect(
      threadControlRequestSchema.parse({ id, control: { kind: "write_mode", mode: "draft" } }),
    ).toEqual({ id, control: { kind: "write_mode", mode: "draft" } });
    expect(
      threadControlRequestSchema.parse({ id, control: { kind: "compact", instructions: "  " } }),
    ).toEqual({ id, control: { kind: "compact" } });
  });

  it.each([
    { kind: "write_mode", mode: "live" },
    { kind: "write_mode" },
    { kind: "write_mode", mode: "draft", instructions: "x" },
    { kind: "compact", mode: "draft" },
  ])("refuses %o", (control) => {
    expect(threadControlRequestSchema.safeParse({ id, control }).success).toBe(false);
  });
});
