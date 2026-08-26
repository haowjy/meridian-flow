/** Wire-boundary validation for the unified thread user-state command. */
import { describe, expect, it } from "vitest";
import { updateThreadUserStateRequestSchema } from "./project-chat-feed.js";

describe("updateThreadUserStateRequestSchema", () => {
  it("accepts either or both desired fields", () => {
    expect(updateThreadUserStateRequestSchema.parse({ isFavorite: true })).toEqual({
      isFavorite: true,
    });
    expect(updateThreadUserStateRequestSchema.parse({ isUnread: false })).toEqual({
      isUnread: false,
    });
    expect(updateThreadUserStateRequestSchema.parse({ isFavorite: false, isUnread: true })).toEqual(
      { isFavorite: false, isUnread: true },
    );
  });

  it("rejects empty, unknown, and mistyped commands", () => {
    expect(updateThreadUserStateRequestSchema.safeParse({}).success).toBe(false);
    expect(updateThreadUserStateRequestSchema.safeParse({ unread: true }).success).toBe(false);
    expect(updateThreadUserStateRequestSchema.safeParse({ isUnread: "yes" }).success).toBe(false);
  });
});
