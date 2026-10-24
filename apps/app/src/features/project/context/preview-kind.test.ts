/**
 * Preview kind behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - preview kind from stored classification
 */
import type { ContextReadResponse } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import type { ContextTab } from "@/client/stores";
import { previewKind } from "./preview-kind";

type ViewerTab = Extract<ContextTab, { kind: "viewer" }>;

function tab(name: string, fileType: ViewerTab["fileType"] = "binary"): ViewerTab {
  return {
    kind: "viewer",
    documentId: "doc",
    scheme: "manuscript",
    path: `/${name}`,
    name,
    editable: false,
    fileType,
  };
}

const tracked = (filetype: "markdown" | "text" | "json"): ContextReadResponse => ({
  kind: "tracked",
  path: "/x",
  schemaType: filetype === "json" ? "code" : "document",
  filetype,
  content: "",
});

const binary = (
  mimeType: string,
  fileType: ViewerTab["fileType"] = "binary",
): ContextReadResponse => ({
  kind: "binary",
  path: "/x",
  url: "https://example.test/x",
  fileType,
  mimeType,
});

describe("previewKind", () => {
  it("previews a prose document by its stored classification, whatever its name", () => {
    expect(previewKind(tab("Chapter 13"), tracked("markdown"))).toBe("markdown");
    expect(previewKind(tab("Vol. 2"), tracked("markdown"))).toBe("markdown");
    expect(previewKind(tab("notes"), tracked("markdown"))).toBe("markdown");
  });

  it("previews a visible-extension file as text, even when its name ends .md", () => {
    expect(previewKind(tab("outline.json"), tracked("json"))).toBe("text");
    expect(previewKind(tab("config.toml"), tracked("text"))).toBe("text");
    expect(previewKind(tab("Story.md"), tracked("text"))).toBe("text");
  });

  it("does not let a binary file's name override its classification", () => {
    expect(previewKind(tab("Story.md", "pdf"), binary("application/pdf", "pdf"))).toBe("pdf");
    expect(previewKind(tab("map.png", "image"), binary("image/png", "image"))).toBe("image");
    expect(previewKind(tab("blob"), binary("application/octet-stream"))).toBe("binary");
    expect(previewKind(tab("data"), binary("application/json"))).toBe("text");
  });
});
