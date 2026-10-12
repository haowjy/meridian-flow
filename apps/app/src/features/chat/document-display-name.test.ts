import { describe, expect, it } from "vitest";

import { descriptorFor } from "./command-descriptor";
import { documentDisplayName } from "./document-display-name";
import type { ToolView } from "./group-delivery-segments";

function tool(toolName: string, input: Record<string, unknown>): ToolView {
  return {
    toolCallId: "call",
    toolName,
    input: input as ToolView["input"],
    result: null,
    status: "complete",
    isError: false,
    message: null,
    streamedOutput: null,
    metadata: null,
  } as ToolView;
}

describe("documentDisplayName", () => {
  it("shows the stored name as it is", () => {
    expect(documentDisplayName("manuscript://Chapter 13")).toBe("Chapter 13");
    expect(documentDisplayName("manuscript://Book/Vol. 2")).toBe("Vol. 2");
    expect(documentDisplayName("scratch://@/c12/outline.json")).toBe("outline.json");
    expect(documentDisplayName("kb://maps/map.png")).toBe("map.png");
  });

  it("shows a prose name a model typed with a suffix without it", () => {
    expect(documentDisplayName("ch12.md")).toBe("ch12");
    expect(documentDisplayName("manuscript://Book/notes.txt")).toBe("notes");
  });
});

describe("tool activity labels", () => {
  const label = (name: string, path: string) => {
    const phrases = descriptorFor(tool(name, { path })).phrases(tool(name, { path }));
    return `${phrases.complete.verb} ${phrases.complete.parameter}`;
  };

  it("names the document by its stored name", () => {
    expect(label("read", "manuscript://ch12")).toBe("Read ch12");
    expect(label("read", "manuscript://outline.json")).toBe("Read outline.json");
    expect(label("read", "ch12.md")).toBe("Read ch12");
    expect(label("read", "manuscript://Chapter 13.md#opening")).toBe("Read Chapter 13");
    expect(label("read", "Chapter 13.md?view=1#opening")).toBe("Read Chapter 13");
  });
});
