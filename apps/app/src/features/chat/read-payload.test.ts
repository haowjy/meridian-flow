import type { JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { readPayloadMarkup, readPayloadOutline } from "./read-payload";

function readEnvelope(
  items: Array<{ hash: string; body: string }>,
  format: "full" | "outline" = "full",
): JsonValue {
  return {
    schema: "meridian.agent-edit.v1",
    command: "read",
    status: "success",
    phase: "committed",
    read: { format },
    blocks: [{ extent: "full", relation: "document", items }],
  };
}

describe("readPayloadMarkup", () => {
  it("flattens hash-free bodies from the agent-edit envelope", () => {
    expect(
      readPayloadMarkup(
        readEnvelope([
          { hash: "h1", body: "First paragraph." },
          { hash: "", body: "Second paragraph." },
        ]),
      ),
    ).toBe("First paragraph.\nSecond paragraph.");
  });

  it("keeps a pipe in envelope prose, which is not a hashline separator", () => {
    expect(readPayloadMarkup(readEnvelope([{ hash: "h1", body: "a | b" }]))).toBe("a | b");
  });

  it("strips hashlines from a serialized string payload", () => {
    expect(readPayloadMarkup("h1|First paragraph.\nh2|Second paragraph.")).toBe(
      "First paragraph.\nSecond paragraph.",
    );
  });

  it("returns empty string for a payload with no document content", () => {
    expect(readPayloadMarkup(null)).toBe("");
    expect(readPayloadMarkup([{ uri: "x" }])).toBe("");
    expect(readPayloadMarkup({ schema: "other", blocks: [] })).toBe("");
  });
});

describe("readPayloadOutline", () => {
  it("reads headings from the envelope and normalizes their depth", () => {
    expect(
      readPayloadOutline(
        readEnvelope(
          [
            { hash: "h1", body: "## Chapter One" },
            { hash: "h2", body: "### Scene" },
          ],
          "outline",
        ),
      ),
    ).toEqual([
      { level: 0, text: "Chapter One" },
      { level: 1, text: "Scene" },
    ]);
  });

  it("returns null for an envelope with no headings, so prose falls back", () => {
    expect(readPayloadOutline(readEnvelope([{ hash: "h1", body: "Just prose." }]))).toBeNull();
  });

  it("reads an outline from a serialized string payload and drops locator lines", () => {
    expect(
      readPayloadOutline('h1|## Chapter One\nread(command="read", path="x#h1")\nh2|## Chapter Two'),
    ).toEqual([
      { level: 0, text: "Chapter One" },
      { level: 0, text: "Chapter Two" },
    ]);
  });
});
