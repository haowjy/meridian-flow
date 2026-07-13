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
});
