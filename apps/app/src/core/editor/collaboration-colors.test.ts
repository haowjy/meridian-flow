// @vitest-environment jsdom
/** Awareness colors must be concrete CSS values, not token references. */
import { afterEach, describe, expect, it } from "vitest";
import {
  COLLABORATION_CURSOR_COLORS,
  collaborationColorFor,
  resolveCollaborationColor,
} from "./collaboration-colors";

afterEach(() => {
  for (let index = 1; index <= COLLABORATION_CURSOR_COLORS.length; index++) {
    document.documentElement.style.removeProperty(`--color-collab-cursor-${index}`);
  }
});

describe("collaboration colors", () => {
  it("resolves token references before publishing a stable identity color", () => {
    for (let index = 1; index <= COLLABORATION_CURSOR_COLORS.length; index++) {
      document.documentElement.style.setProperty(
        `--color-collab-cursor-${index}`,
        "rgb(12, 34, 56)",
      );
    }

    expect(collaborationColorFor("thread-1")).toBe("rgb(12, 34, 56)");
  });

  it("preserves a token when styles are not available yet", () => {
    expect(resolveCollaborationColor("var(--color-collab-cursor-1)")).toBe(
      "var(--color-collab-cursor-1)",
    );
  });
});
