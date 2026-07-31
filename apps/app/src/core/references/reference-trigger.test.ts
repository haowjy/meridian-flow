/**
 * Where `@` opens a menu in plain text, and what a pick leaves behind.
 *
 * The envelope is the interesting half: an email address and "meet @ noon"
 * are prose a writer would be furious to see a menu over, while an `@` after
 * an opening parenthesis is a request. The splice half is about the two
 * spellings — the title a writer reads, and the URI a shared title forces.
 */

import { describe, expect, it } from "vitest";

import {
  findReferenceToken,
  type ReferenceDocumentItem,
  referenceSpelling,
  spliceReference,
} from "./reference-trigger";

/** The token as `from|query`, which is everything a host reads off one. */
function token(text: string, caret = text.length): string | null {
  const found = findReferenceToken(text, caret);
  return found && `${found.from}|${found.query}`;
}

function documentItem(name: string, overrides: Partial<ReferenceDocumentItem> = {}) {
  return {
    kind: "document",
    key: "document-0",
    name,
    location: "Chapters",
    documentId: "document-1",
    uri: "manuscript://chapters/the-third-gate.md",
    matchedAlias: null,
    ambiguous: false,
    ...overrides,
  } satisfies ReferenceDocumentItem;
}

describe("where @ opens", () => {
  it("opens on an @ that starts the message", () => {
    expect(token("@thi")).toBe("0|thi");
  });

  it("opens on an @ after a space, with the empty query a bare @ asks", () => {
    expect(token("Rewrite @")).toBe("8|");
  });

  it("opens after punctuation, where a reference legitimately follows", () => {
    expect(token("Rewrite (@thi")).toBe("9|thi");
    expect(token("Rewrite “@thi")).toBe("9|thi");
  });

  it("stays shut inside an email address, which is what a lone @ usually is", () => {
    expect(token("write to kael@example.com")).toBeNull();
  });

  it("stays shut mid-word", () => {
    expect(token("chapter2@3")).toBeNull();
  });

  it("keeps spaces in the query, because document titles have them", () => {
    expect(token("Rewrite @The Third")).toBe("8|The Third");
  });

  it("takes the nearest @ when the message carries two", () => {
    expect(token("@one and @two")).toBe("9|two");
  });

  it("dies at the end of the line it opened on", () => {
    expect(token("@thi\nand then")).toBeNull();
  });

  it("reads the caret, not the end of the message", () => {
    expect(token("Rewrite @thi rd gate", 12)).toBe("8|thi");
  });

  it("gives up rather than reading a whole message back", () => {
    expect(token(`@${"a".repeat(200)}`)).toBeNull();
  });

  it("refuses a caret outside the text", () => {
    expect(findReferenceToken("@thi", 9)).toBeNull();
    expect(findReferenceToken("@thi", -1)).toBeNull();
  });
});

describe("what a pick spells", () => {
  it("writes the title, which reads as prose and renders as a link", () => {
    expect(referenceSpelling(documentItem("The Third Gate"))).toBe("[[The Third Gate]]");
  });

  it("names the exact document when the title reaches two of them", () => {
    expect(referenceSpelling(documentItem("Notes", { ambiguous: true }))).toBe(
      "manuscript://chapters/the-third-gate.md",
    );
  });

  it("falls back to the URI for a title the wire format cannot carry", () => {
    // `|` is the aliased spelling this dialect does not have, so `[[…]]` would
    // round-trip as something else entirely.
    expect(referenceSpelling(documentItem("Kael|the warden"))).toBe(
      "manuscript://chapters/the-third-gate.md",
    );
  });
});

describe("what a pick leaves behind", () => {
  it("replaces the token and lands the caret past it", () => {
    const before = "Rewrite the fight in @thi";
    const found = findReferenceToken(before, before.length);
    if (!found) throw new Error("expected a token");

    expect(spliceReference(before, found, "[[The Third Gate]]")).toEqual({
      text: "Rewrite the fight in [[The Third Gate]] ",
      caret: 40,
    });
  });

  it("keeps the rest of the sentence, and does not double a space it already has", () => {
    const before = "Rewrite @thi to match the map";
    const found = findReferenceToken(before, 12);
    if (!found) throw new Error("expected a token");

    expect(spliceReference(before, found, "[[The Third Gate]]")).toEqual({
      text: "Rewrite [[The Third Gate]] to match the map",
      caret: 26,
    });
  });
});
