/** Boundary tests for explicit thread favorite commands. */
import { describe, expect, it } from "vitest";
import { updateThreadUserStateRequestSchema } from "./project-chat-feed.js";

describe("updateThreadUserStateRequestSchema", () => {
  it("accepts only a favorite desired state", () => {
    expect(updateThreadUserStateRequestSchema.parse({ isFavorite: false })).toEqual({
      isFavorite: false,
    });
  });

  it.each([
    {},
    { acknowledgeOpen: true },
    { legacyReadState: true },
  ])("rejects bodies without exactly favorite state", (body) =>
    expect(updateThreadUserStateRequestSchema.safeParse(body).success).toBe(false));
});
