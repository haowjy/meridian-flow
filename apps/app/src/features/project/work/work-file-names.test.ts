/**
 * Work file names behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Work note name allocation (kb/wiki/architecture/documents/placement-and-naming.md#a-document-has-one-canonical-name)
 */
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

  it("skips taken numbers", () => {
    expect(uniqueScratchNoteName("note.json", ["note.json", "note (2).json"])).toBe(
      "note (3).json",
    );
  });
});
