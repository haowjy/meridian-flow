/** Document naming laws, including canonical round trips and explicit destination types. */
import { describe, expect, it } from "vitest";
import {
  parseBinaryFilename,
  parseDocumentFilename,
  renderFilename,
  storedFilename,
} from "./document-filename.js";
import {
  classifyFiletype,
  filetypeForKnownMimeType,
  filetypeForKnownPath,
  filetypeForPath,
} from "./filetype.js";

describe("document filename codec", () => {
  it("normalizes prose, preserves registered suffixes, and round-trips stored parts", () => {
    const cases: string[][] = [
      ["Chapter 13", "Chapter 13", "", "markdown"],
      ...["md", "txt", "markdown", "mdx", "TXT", "md.md"].map((suffix) => [
        `Chapter 13.${suffix}`,
        "Chapter 13",
        "",
        "markdown",
      ]),
      [" config.toml ", "config", "toml", "text"],
      ["app.tsx", "app", "tsx", "typescript"],
      ["Pic.PNG", "Pic", "png", "png"],
      ...["Vol. 2", "Chapter 1.5", "ch12.draft", "foo.constructor", "foo.__proto__"].map((name) => [
        name,
        name,
        "",
        "markdown",
      ]),
    ];
    for (const [input, name, extension, filetype] of cases) {
      const result = parseDocumentFilename(input ?? "");
      expect(result).toEqual({ ok: true, value: { name, extension, filetype } });
      if (result.ok)
        expect(
          parseDocumentFilename(renderFilename(result.value.name, result.value.extension)),
        ).toEqual(result);
    }
    for (const sourceExtension of ["toml", "xml", "json", "", "png"]) {
      const result = parseDocumentFilename("settings", { sourceExtension });
      expect(result.ok && result.value.extension).toBe(sourceExtension);
      if (result.ok)
        expect(
          parseDocumentFilename(renderFilename(result.value.name, result.value.extension)),
        ).toEqual(result);
    }
    expect(parseDocumentFilename("settings.txt", { sourceExtension: "toml" })).toEqual({
      ok: true,
      value: { name: "settings", extension: "", filetype: "markdown" },
    });
    expect(parseBinaryFilename("Pic.PNG")).toEqual({
      ok: true,
      value: { name: "Pic", extension: "png", filetype: "png" },
    });
    expect(parseBinaryFilename("archive.unknown").ok).toBe(true);
    for (const unregistered of ["constructor", "__proto__", "toString"]) {
      expect(classifyFiletype(unregistered)).toEqual({ kind: "unknown" });
      expect(filetypeForKnownMimeType(unregistered)).toBeNull();
    }
  });
  it("round-trips generated dotted names, explicit extensions and inherited destinations", () => {
    for (const stem of [
      "chapter",
      "Chapter 1.5",
      "Vol. 2",
      ".hidden",
      "ch12.draft",
      "part.md.middle",
      "data.json",
    ])
      for (const suffix of [
        "",
        ".md",
        ".TXT",
        ".md.md",
        ".markdown.mdx",
        ".ts",
        ".TSX",
        ".toml",
        ".xml",
        ".JSON",
        ".jpeg",
        ".PNG",
        ".unknown",
      ])
        for (const sourceExtension of [undefined, "", "json", "toml", "png"]) {
          const input = ` ${stem}${suffix} `;
          const result = parseDocumentFilename(input, { sourceExtension });
          if (result.ok)
            expect(
              parseDocumentFilename(renderFilename(result.value.name, result.value.extension)),
            ).toEqual(result);
          const binary = parseBinaryFilename(input, { sourceExtension });
          if (binary.ok)
            expect(
              parseBinaryFilename(renderFilename(binary.value.name, binary.value.extension)),
            ).toEqual(binary);
        }
    for (const path of ["chapter", "chapter.draft", "folder.md/chapter"]) {
      expect(filetypeForPath(path)).toBe("markdown");
      expect(filetypeForKnownPath(path)).toBeNull();
    }
    for (const path of ["chapter.txt", "chapter.mdx", "chapter.MD"])
      expect(filetypeForKnownPath(path)).toBe("markdown");
  });
  it("refuses empty stems and prose names that impersonate registered non-prose files", () => {
    for (const input of ["", " ", ".", "..", ".md", " .TXT ", "data.json.md", "data.json.txt.md"]) {
      expect(parseDocumentFilename(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_name" },
      });
    }
    const result = parseDocumentFilename("data.json.md");
    if (!result.ok) expect(result.error.message).toContain("drop `.json`");
  });
});

const stored = (raw: string, current?: string) => {
  const result = storedFilename(raw, current);
  return result.ok ? result.name : `refused: ${result.message}`;
};

describe("storedFilename", () => {
  it("stores a prose document without an extension", () => {
    expect(stored("Chapter 13")).toBe("Chapter 13");
    expect(stored("Chapter 13.md")).toBe("Chapter 13");
    expect(stored("Chapter 13.txt")).toBe("Chapter 13");
    expect(stored("notes.txt")).toBe("notes");
  });

  it("keeps a visible extension, lower-cased", () => {
    expect(stored("outline.json")).toBe("outline.json");
    expect(stored("Map.PNG")).toBe("Map.png");
  });

  it("treats a dotted name as a name", () => {
    expect(stored("Vol. 2")).toBe("Vol. 2");
    expect(stored("Chapter 1.5")).toBe("Chapter 1.5");
  });

  it("keeps the renamed file's extension when none is typed", () => {
    expect(stored("settings", "config.toml")).toBe("settings.toml");
    expect(stored("pic", "map.png")).toBe("pic.png");
    expect(stored("Chapter 14", "Chapter 13")).toBe("Chapter 14");
  });

  it("lets a typed extension state the type", () => {
    expect(stored("Chapter 13.md", "config.toml")).toBe("Chapter 13");
  });

  it("passes the codec's refusal through", () => {
    expect(stored("data.json.md")).toMatch(
      /^refused: .*data\.json\.md.*would show as .*data\.json/,
    );
    expect(stored(".md")).toMatch(/^refused: /);
  });
});
