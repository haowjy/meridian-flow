import { describe, expect, it } from "vitest";
import { findWikiLinks } from "@/core/editor/codemirror/wikiLinks";

describe("findWikiLinks", () => {
  it("falls back to path range when alias is whitespace-only", () => {
    const input = "[[google.com | ]]";
    const [link] = findWikiLinks(input, 0);

    expect(link).toBeDefined();
    expect(link?.path).toBe("google.com");
    expect(link?.displayName).toBe("google.com");
    expect(input.slice(link!.displayFrom, link!.displayTo)).toBe("google.com");
  });

  it("keeps alias range when alias has visible text", () => {
    const input = "[[google.com | Google]]";
    const [link] = findWikiLinks(input, 0);

    expect(link).toBeDefined();
    expect(link?.displayName).toBe("Google");
    expect(input.slice(link!.displayFrom, link!.displayTo)).toBe("Google");
  });

  it("does not match wiki-links that span lines", () => {
    const withMultilineAlias = "[[google.com |\nGoogle]]";
    const withMultilinePath = "[[google.\ncom]]";

    expect(findWikiLinks(withMultilineAlias, 0)).toHaveLength(0);
    expect(findWikiLinks(withMultilinePath, 0)).toHaveLength(0);
  });
});
