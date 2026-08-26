/** Boundary tests for explicit thread user-state commands. */
import { describe, expect, it } from "vitest";
import { updateThreadUserStateRequestSchema } from "./project-chat-feed.js";

describe("updateThreadUserStateRequestSchema", () => {
  it("accepts favorite desired state and one-way open acknowledgement", () => {
    expect(updateThreadUserStateRequestSchema.parse({ isFavorite: false })).toEqual({
      isFavorite: false,
    });
    expect(updateThreadUserStateRequestSchema.parse({ acknowledgeOpen: true })).toEqual({
      acknowledgeOpen: true,
    });
    expect(
      updateThreadUserStateRequestSchema.parse({ isFavorite: true, acknowledgeOpen: true }),
    ).toEqual({ isFavorite: true, acknowledgeOpen: true });
  });

  it.each([
    {},
    { acknowledgeOpen: false },
    { legacyReadState: true },
  ])("rejects empty, reversible, and legacy read-state bodies", (body) =>
    expect(updateThreadUserStateRequestSchema.safeParse(body).success).toBe(false));
});
