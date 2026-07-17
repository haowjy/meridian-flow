import type { ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  type FileSuggestion,
  flattenFileSuggestionTrees,
  folderChildren,
  matchFileSuggestions,
  parentPath,
} from "./file-suggestions";

const manuscript: ProjectContextTreeDirectory = {
  kind: "dir",
  name: "Manuscript",
  path: "/",
  uri: "manuscript://",
  children: [
    {
      kind: "dir",
      name: "Arc One",
      path: "/Arc One",
      uri: "manuscript://Arc One",
      children: [
        {
          kind: "file",
          name: "Azure Gate.md",
          path: "/Arc One/Azure Gate.md",
          uri: "manuscript://Arc One/Azure Gate.md",
          documentId: "azure",
          editable: true,
          filetype: "markdown",
          schemaType: "document",
          provisionalName: false,
        },
      ],
    },
  ],
};

describe("flattenFileSuggestionTrees", () => {
  it("includes roots and descendants with their scheme and parent segments", () => {
    expect(flattenFileSuggestionTrees([{ scheme: "manuscript", tree: manuscript }])).toEqual([
      { scheme: "manuscript", path: "/", name: "Manuscript", kind: "dir", parents: [] },
      { scheme: "manuscript", path: "/Arc One", name: "Arc One", kind: "dir", parents: [] },
      {
        scheme: "manuscript",
        path: "/Arc One/Azure Gate.md",
        name: "Azure Gate.md",
        kind: "file",
        parents: ["Arc One"],
      },
    ]);
  });
});

describe("matchFileSuggestions", () => {
  const entry = (
    name: string,
    path: string,
    parents: readonly string[] = [],
    kind: FileSuggestion["kind"] = "file",
    scheme: FileSuggestion["scheme"] = "manuscript",
  ): FileSuggestion => ({ name, path, parents, kind, scheme });

  it("ranks leaf starts before leaf word boundaries before path substrings", () => {
    const entries = [
      entry("Notes", "/Azure/Notes", ["Azure"]),
      entry("Gate Azure", "/Gate Azure", []),
      entry("Azure Archive", "/Deep/Azure Archive", ["Deep"]),
    ];
    expect(matchFileSuggestions(entries, "azure").map(({ name }) => name)).toEqual([
      "Azure Archive",
      "Gate Azure",
      "Notes",
    ]);
  });

  it("prefers shallower paths when match quality ties", () => {
    const entries = [entry("Azure Deep", "/a/b/Azure Deep", ["a", "b"]), entry("Azure", "/Azure")];
    expect(matchFileSuggestions(entries, "azu").map(({ path }) => path)).toEqual([
      "/Azure",
      "/a/b/Azure Deep",
    ]);
  });

  it("matches case-insensitively, trims queries, and preserves tree order for ties", () => {
    const entries = [entry("Beta", "/Beta"), entry("beta two", "/beta two")];
    expect(matchFileSuggestions(entries, "  BE ")).toEqual(entries);
    expect(matchFileSuggestions(entries, "")).toEqual(entries);
  });

  it("filters kinds and schemes before matching", () => {
    const entries = [
      entry("Arc", "/Arc", [], "dir"),
      entry("Arc.md", "/Arc.md"),
      entry("Arc", "/Arc", [], "dir", "kb"),
    ];
    expect(matchFileSuggestions(entries, "arc", { kinds: ["dir"], schemes: ["kb"] })).toEqual([
      entries[2],
    ]);
  });

  it("excludes entries with no leaf or path match", () => {
    expect(matchFileSuggestions([entry("Chapter", "/Arc/Chapter")], "missing")).toEqual([]);
  });
});

describe("folderChildren", () => {
  const entries = [
    { scheme: "manuscript", path: "/", name: "Manuscript", kind: "dir", parents: [] },
    { scheme: "manuscript", path: "/gel", name: "gel", kind: "dir", parents: [] },
    { scheme: "manuscript", path: "/gel/arc-1", name: "arc-1", kind: "dir", parents: ["gel"] },
    { scheme: "manuscript", path: "/gel/ch.md", name: "ch.md", kind: "file", parents: ["gel"] },
    { scheme: "manuscript", path: "/notes.md", name: "notes.md", kind: "file", parents: [] },
    { scheme: "kb", path: "/", name: "Knowledge Base", kind: "dir", parents: [] },
    { scheme: "kb", path: "/lore", name: "lore", kind: "dir", parents: [] },
  ] satisfies readonly FileSuggestion[];

  it("lists root children without the scheme-root entry itself", () => {
    expect(folderChildren(entries, "manuscript", "/").map((e) => e.path)).toEqual([
      "/gel",
      "/notes.md",
    ]);
  });

  it("lists one folder's children, directories first", () => {
    expect(folderChildren(entries, "manuscript", "/gel").map((e) => e.path)).toEqual([
      "/gel/arc-1",
      "/gel/ch.md",
    ]);
  });

  it("never crosses schemes", () => {
    expect(folderChildren(entries, "kb", "/").map((e) => e.path)).toEqual(["/lore"]);
  });
});

describe("parentPath", () => {
  it("walks up one segment and stops at root", () => {
    expect(parentPath("/gel/arc-1")).toBe("/gel");
    expect(parentPath("/gel")).toBe("/");
    expect(parentPath("/")).toBe("/");
  });
});
