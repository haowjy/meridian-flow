/** Stable creation-time thread slug generation, including untitled chats. */
import { describe, expect, it } from "vitest";
import { threadSlugBase, uniqueThreadSlug } from "./thread-slug.js";

describe("thread slugs", () => {
  it("slugifies a human title", () => {
    expect(threadSlugBase("  Éowyn's Last Stand!  ")).toBe("eowyn-s-last-stand");
  });

  it("assigns a chat fallback while untitled", () => {
    expect(threadSlugBase(null)).toBe("chat");
    expect(threadSlugBase("   ")).toBe("chat");
  });

  it("uses -2 and increasing counters on collision", () => {
    expect(uniqueThreadSlug("Chapter Plan", ["chapter-plan"])).toBe("chapter-plan-2");
    expect(uniqueThreadSlug("Chapter Plan", ["chapter-plan", "chapter-plan-2"])).toBe(
      "chapter-plan-3",
    );
  });
});
