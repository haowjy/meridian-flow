import { describe, expect, it } from "vitest";
import { uniqueScratchNoteName } from "./work-file-names";

describe("uniqueScratchNoteName", () => {
  it("keeps the base name when it is free and numbers collisions before the extension", () => {
    expect(uniqueScratchNoteName("Scratch note 2026-09-27.md", [])).toBe(
      "Scratch note 2026-09-27.md",
    );
    expect(
      uniqueScratchNoteName("Scratch note 2026-09-27.md", [
        "Scratch note 2026-09-27.md",
        "Scratch note 2026-09-27 2.md",
      ]),
    ).toBe("Scratch note 2026-09-27 3.md");
  });
});
