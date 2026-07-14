import { describe, expect, it } from "vitest";

import { formatSaveUri, parseSaveUri, saveUriSuggestionQuery } from "./temp-save-uri";

describe("formatSaveUri", () => {
  it("formats a root destination", () => {
    expect(formatSaveUri({ scheme: "manuscript", path: "/" }, "Untitled")).toBe(
      "manuscript://Untitled",
    );
  });

  it("formats nested folders", () => {
    expect(formatSaveUri({ scheme: "kb", path: "/notes/lore" }, "gods.md")).toBe(
      "kb://notes/lore/gods.md",
    );
  });
});

describe("parseSaveUri", () => {
  it("round-trips format output", () => {
    const destination = { scheme: "manuscript", path: "/arc-2" } as const;
    expect(parseSaveUri(formatSaveUri(destination, "chapter-9.md"))).toEqual({
      destination,
      name: "chapter-9.md",
    });
  });

  it("parses a bare-scheme URI as root destination", () => {
    expect(parseSaveUri("user://prefs.md")).toEqual({
      destination: { scheme: "user", path: "/" },
      name: "prefs.md",
    });
  });

  it("collapses empty and padded segments", () => {
    expect(parseSaveUri("manuscript:// arc-1 //ch.md")).toEqual({
      destination: { scheme: "manuscript", path: "/arc-1" },
      name: "ch.md",
    });
  });

  it("rejects text without a scheme", () => {
    expect(parseSaveUri("arc-1/ch.md")).toBeNull();
  });

  it("rejects non-durable schemes", () => {
    expect(parseSaveUri("scratch://notes.md")).toBeNull();
    expect(parseSaveUri("https://example.com/x")).toBeNull();
  });

  it("rejects an empty or trailing-slash name", () => {
    expect(parseSaveUri("manuscript://")).toBeNull();
    expect(parseSaveUri("manuscript://arc-1/")).toBeNull();
  });
});

describe("saveUriSuggestionQuery", () => {
  it("returns the in-progress token", () => {
    expect(saveUriSuggestionQuery("manuscript://ge")).toBe("ge");
    expect(saveUriSuggestionQuery("manuscript://gel/Unti")).toBe("Unti");
  });

  it("browses everything after a slash or bare scheme", () => {
    expect(saveUriSuggestionQuery("manuscript://gel/")).toBe("");
    expect(saveUriSuggestionQuery("manuscript://")).toBe("");
  });

  it("falls back to the raw text without a scheme", () => {
    expect(saveUriSuggestionQuery("gel")).toBe("gel");
  });
});
