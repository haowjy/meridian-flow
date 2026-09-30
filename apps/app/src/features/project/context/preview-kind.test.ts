import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { previewKind } from "./preview-kind";

const viewer = (
  name: string,
  fileType: Extract<ContextTab, { kind: "viewer" }>["fileType"] = "binary",
) => ({
  kind: "viewer" as const,
  documentId: name,
  scheme: "kb" as const,
  path: `/${name}`,
  name,
  editable: false as const,
  fileType,
});

const binary = (fileType: "binary" | "image" | "pdf", mimeType: string) => ({
  kind: "binary" as const,
  path: "/file",
  url: "/signed-file",
  fileType,
  mimeType,
});

describe("previewKind", () => {
  it("routes tracked reads as read-only text in every host", () => {
    const tracked = {
      kind: "tracked" as const,
      path: "/Note.md",
      schemaType: "document" as const,
      filetype: "markdown" as const,
      content: "A note",
    };
    expect(previewKind(viewer("Note.md"), tracked)).toBe("markdown");
    expect(previewKind(viewer("Note.txt"), { ...tracked, path: "/Note.txt" })).toBe("text");
  });

  it("preserves stored image and PDF classification over misleading names and MIME", () => {
    expect(previewKind(viewer("Map.png", "image"), binary("image", "image/png"))).toBe("image");
    expect(previewKind(viewer("Story.md", "pdf"), binary("pdf", "application/pdf"))).toBe(
      "markdown",
    );
    expect(previewKind(viewer("archive.bin"), binary("binary", "application/octet-stream"))).toBe(
      "binary",
    );
  });
});
