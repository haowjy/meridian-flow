import type { ProjectContextTreeFile } from "@meridian/contracts/protocol";
import { FileCode, FileImage, FileText } from "lucide-react";
import { describe, expect, it } from "vitest";
import { fileKindIcon } from "./context-file-icon";

describe("fileKindIcon", () => {
  it.each([
    ["chapter-2", FileText],
    ["chapter.prose", FileText],
    ["chapter.txt", FileText],
    ["settings.toml", FileText],
    ["script.py", FileCode],
    ["cover.png", FileImage],
  ])("classifies %s through the canonical filetype registry", (name, icon) => {
    expect(fileKindIcon(name)).toBe(icon);
  });

  it("uses server storage metadata for an image with an unregistered extension", () => {
    const webp = {
      kind: "file",
      name: "cover.webp",
      path: "cover.webp",
      editable: false,
      fileType: "image",
    } as ProjectContextTreeFile;

    expect(fileKindIcon(webp)).toBe(FileImage);
    expect(fileKindIcon(webp.name)).toBe(FileText);
  });
});
