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
  it("returns each block's hash-free body as its own paragraph", () => {
    expect(
      readPayloadMarkup(
        readEnvelope([
          { hash: "h1", body: "First paragraph." },
          { hash: "", body: "Second paragraph." },
        ]),
      ),
    ).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("keeps a pipe in envelope prose, which is not a hashline separator", () => {
    expect(readPayloadMarkup(readEnvelope([{ hash: "h1", body: "a | b" }]))).toBe("a | b");
  });

  it("reads only the document blocks", () => {
    const result = {
      schema: "meridian.agent-edit.v1",
      command: "read",
      status: "success",
      phase: "committed",
      blocks: [
        { extent: "full", relation: "document", items: [{ hash: "h1", body: "Kept." }] },
        { extent: "full", relation: "swept", items: [{ hash: "h2", body: "Swept." }] },
      ],
    } satisfies JsonValue;
    expect(readPayloadMarkup(result)).toBe("Kept.");
  });

  it("returns empty string for a value that isn't a read result", () => {
    expect(readPayloadMarkup(null)).toBe("");
    // A row from before `result` existed: only the model's text, never parsed.
    expect(readPayloadMarkup("status: success; path: ch1.md\n\nh1|First paragraph.")).toBe("");
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

  it("returns null for a value that isn't a read result", () => {
    expect(readPayloadOutline(null)).toBeNull();
    expect(readPayloadOutline('h1|## Chapter One\nread({"path": "x#h1"})')).toBeNull();
  });
});
