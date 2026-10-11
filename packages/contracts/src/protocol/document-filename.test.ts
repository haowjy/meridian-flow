/** Document naming laws, including canonical round trips and explicit destination types. */
import { describe, expect, it } from "vitest";
import { filenameForBinary, parseDocumentFilename, renderFilename } from "./document-filename.js";
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
    expect(parseDocumentFilename("Pic.PNG")).toEqual({
      ok: true,
      value: { name: "Pic", extension: "png", filetype: "png" },
    });
    expect(parseDocumentFilename("archive.unknown").ok).toBe(true);
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
        }
    for (const path of ["chapter", "chapter.draft", "folder.md/chapter"]) {
      expect(filetypeForPath(path)).toBe("markdown");
      expect(filetypeForKnownPath(path)).toBeNull();
    }
    for (const path of ["chapter.txt", "chapter.mdx", "chapter.MD"])
      expect(filetypeForKnownPath(path)).toBe("markdown");
  });
  it("chooses binary storage suffixes without a second identity parser", () => {
    for (const [input, type, mime, name, extension] of [
      ["x.txt", "pdf", "application/pdf", "x", "pdf"],
      ["image.md.md", "image", "image/png", "image", "png"],
      ["LICENSE", "binary", "application/octet-stream", "LICENSE", ""],
      ["notes.txt", "binary", "text/plain", "notes", ""],
      ["x.PNG", "pdf", "application/pdf", "x", "png"],
    ]) {
      const parsed = parseDocumentFilename(input ?? "");
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const result = filenameForBinary(parsed.value, type ?? "", mime);
      expect(result).toMatchObject({ name, extension });
      expect(parseDocumentFilename(renderFilename(result.name, result.extension))).toEqual({
        ok: true,
        value: result,
      });
    }
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
