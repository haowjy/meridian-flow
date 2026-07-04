import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

describe("cn — custom font-size tokens", () => {
  // Regression: vanilla tailwind-merge mis-classifies our custom `text-*` size
  // roles as colors and silently drops them next to a `text-<color>`, rendering
  // the element at the inherited 16px. The extended twMerge config must treat
  // these as font sizes.
  it("keeps a custom size token when combined with a text color", () => {
    expect(cn("text-meta text-foreground")).toBe("text-meta text-foreground");
    expect(cn("text-body text-primary-foreground")).toBe("text-body text-primary-foreground");
    expect(cn("text-fine text-muted-foreground")).toBe("text-fine text-muted-foreground");
  });

  it("resolves two size roles by last-one-wins", () => {
    expect(cn("text-meta text-body")).toBe("text-body");
  });

  it("lets a custom size token override a built-in size", () => {
    expect(cn("text-sm text-meta")).toBe("text-meta");
  });

  it("still collapses conflicting real text colors", () => {
    expect(cn("text-red-500 text-foreground")).toBe("text-foreground");
  });
});
