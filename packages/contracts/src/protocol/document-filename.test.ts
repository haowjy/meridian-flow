/** Document naming laws, including canonical round trips and explicit destination types.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Registered extensions and smallest-free filename allocation
 */
import { describe, expect, it } from "vitest";
import {
  filenameForBinary,
  freeFilename,
  type NamedRow,
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

const stored = (raw: string, current?: NamedRow) => {
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
    expect(stored("settings", { extension: "toml", editable: true })).toBe("settings.toml");
    expect(stored("pic", { extension: "png", editable: false })).toBe("pic.png");
    expect(stored("Chapter 14", { extension: "", editable: true })).toBe("Chapter 14");
  });

  it("lets a typed extension state the type", () => {
    expect(stored("Chapter 13.md", { extension: "toml", editable: true })).toBe("Chapter 13");
    expect(stored("Notes.txt", { extension: "pdf", editable: false })).toBe("Notes.txt");
    expect(stored("page", { extension: "html", editable: false })).toBe("page.html");
    expect(stored("x.md", { extension: "md", editable: false })).toBe("x.md");
  });

  it("passes the codec's refusal through", () => {
    expect(stored("data.json.md")).toMatch(
      /^refused: .*data\.json\.md.*would show as .*data\.json/,
    );
    expect(stored(".md")).toMatch(/^refused: /);
  });
});

describe("free filenames", () => {
  it("counts documents and folders by their literal rendered names", async () => {
    const taken = new Set(["Lore.md", "Map", "Map (2)"]);
    await expect(freeFilename({ name: "Map" }, (name) => taken.has(name))).resolves.toBe("Map (3)");
    await expect(freeFilename({ name: "Lore" }, (name) => taken.has(name))).resolves.toBe("Lore");
    await expect(
      freeFilename({ name: "Lore", extension: "md" }, (name) => taken.has(name)),
    ).resolves.toBe("Lore (2).md");
  });
});
