/** Where a link to a document nobody has written yet points. */
import { describe, expect, it } from "vitest";

import { documentFileName, linkAheadAddress } from "./link-address";

describe("linkAheadAddress", () => {
  it("puts the document beside its holder, with the filename rule", () => {
    expect(linkAheadAddress("manuscript://volume-2/chapter-1.md", "Lin Mei")).toBe(
      "manuscript://volume-2/Lin Mei.md",
    );
    expect(linkAheadAddress("kb://characters/index.md", " notes.md ")).toBe(
      "kb://characters/notes.md",
    );
    expect(linkAheadAddress("scratch://@revision/plan.md", "Gate")).toBe(
      "scratch://@revision/Gate.md",
    );
  });

  it("puts it at the manuscript root from a holder with no address yet", () => {
    expect(linkAheadAddress(null, "Lin Mei")).toBe("manuscript://Lin Mei.md");
  });

  it("offers nothing for a name that cannot be a filename", () => {
    for (const name of ["", "a/b", "@slug", "bad:name", ".."]) {
      expect(linkAheadAddress("manuscript://chapter.md", name)).toBeNull();
    }
  });
});

describe("documentFileName", () => {
  it("keeps a document filename and gives anything else `.md`", () => {
    expect(documentFileName("chapter.md")).toBe("chapter.md");
    expect(documentFileName("Lin Feng")).toBe("Lin Feng.md");
    expect(documentFileName("notes.v2")).toBe("notes.v2.md");
  });
});
