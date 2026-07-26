// @vitest-environment jsdom
/** Awareness colors must be concrete CSS values, not token references. */
import { afterEach, describe, expect, it, vi } from "vitest";
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

    expect(collaborationColorFor("thread-1")).toBe("#0c2238");
  });

  it("converts the actual OKLCH token shape to y-prosemirror's six-digit RGB format", () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    getContext.mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([45, 123, 91, 255]) }),
      set fillStyle(_value: string) {},
    } as unknown as CanvasRenderingContext2D);
    document.documentElement.style.setProperty("--color-collab-cursor-1", "oklch(0.52 0.13 165)");

    expect(resolveCollaborationColor("var(--color-collab-cursor-1)")).toBe("#2d7b5b");

    getContext.mockRestore();
  });

  it("preserves a token when styles are not available yet", () => {
    expect(resolveCollaborationColor("var(--color-collab-cursor-1)")).toBe(
      "var(--color-collab-cursor-1)",
    );
  });
});
