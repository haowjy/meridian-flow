import { describe, expect, it } from "vitest";

import { readPayloadMarkup, readPayloadOutline } from "./read-payload";

describe("readPayloadMarkup", () => {
  it("drops the hash a read payload carries per block", () => {
    expect(readPayloadMarkup("10aa|# The Long Descent\n7f21|The stair spiralled down.")).toBe(
      "# The Long Descent\nThe stair spiralled down.",
    );
  });

  it("drops an empty hash without leaving its separator in the prose", () => {
    // serializeBlocks emits `|body` when it has no hash for a block. An
    // anchored prefix match correctly refuses that, so this payload has to be
    // read as the serialization it is.
    expect(readPayloadMarkup("|A body with no hash.")).toBe("A body with no hash.");
  });

  it("keeps a table row that was never hash-prefixed", () => {
    expect(readPayloadMarkup("10aa|| Name | Role |")).toBe("| Name | Role |");
  });
});

describe("readPayloadOutline", () => {
  it("keeps the headings and drops the locators the model reads by", () => {
    const output = [
      "10aa|# The Long Descent",
      'write(command="read", file="manuscript://chapter-3.md#10aa")',
      "7f21|## What the forge remembered",
      'write(command="read", file="manuscript://chapter-3.md#7f21")',
    ].join("\n");

    expect(readPayloadOutline(output)).toEqual([
      { level: 0, text: "The Long Descent" },
      { level: 1, text: "What the forge remembered" },
    ]);
  });

  it("keeps a heading whose hash came through empty", () => {
    expect(readPayloadOutline("|# The Long Descent")).toEqual([
      { level: 0, text: "The Long Descent" },
    ]);
  });

  it("indents relative to the shallowest heading present", () => {
    const output = ["10aa|## Chapter start", "7f21|### A turn"].join("\n");

    expect(readPayloadOutline(output)).toEqual([
      { level: 0, text: "Chapter start" },
      { level: 1, text: "A turn" },
    ]);
  });

  it("reports no outline when the payload is prose", () => {
    // renderOutline falls back to whole blocks for a document with no
    // headings, so the caller renders that payload as the prose it is.
    expect(readPayloadOutline("10aa|Just a paragraph.")).toBeNull();
  });
});
