import { describe, expect, it } from "vitest";

import { uniqueScratchNoteName } from "./work-file-names";

describe("uniqueScratchNoteName", () => {
  it("keeps a free name", () => {
    expect(uniqueScratchNoteName("Scratch note", ["Other"])).toBe("Scratch note");
  });

  it("numbers a clash before the extension, the way the server does", () => {
    expect(uniqueScratchNoteName("Scratch note", ["Scratch note"])).toBe("Scratch note (2)");
    expect(uniqueScratchNoteName("note.json", ["note.json"])).toBe("note (2).json");
  });

  it("does not split a dotted prose name", () => {
    expect(uniqueScratchNoteName("Vol. 2", ["Vol. 2"])).toBe("Vol. 2 (2)");
  });

  it("skips taken numbers", () => {
    expect(uniqueScratchNoteName("note.json", ["note.json", "note (2).json"])).toBe(
      "note (3).json",
    );
  });

  it("counts a typed `.md` sibling as the same prose name", () => {
    expect(uniqueScratchNoteName("Chapter 13", ["Chapter 13.md"])).toBe("Chapter 13 (2)");
  });
});
