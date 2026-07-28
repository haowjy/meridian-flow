/** The resolution ladder: what a search-match door does when the passage moved. */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { resolvePassage } from "./passage-resolution";

const schema = buildDocumentSchema();

function docOf(...paragraphs: string[]): PMNode {
  return schema.node(
    "doc",
    null,
    paragraphs.map((text) =>
      schema.node("paragraph", null, text.length > 0 ? [schema.text(text)] : []),
    ),
  );
}

/** Outer span of the nth top-level block, the way a block hash resolves to one. */
function blockSpan(doc: PMNode, index: number): { from: number; to: number } {
  let from = 0;
  for (let i = 0; i < index; i += 1) from += doc.child(i).nodeSize;
  return { from, to: from + doc.child(index).nodeSize };
}

describe("resolvePassage", () => {
  it("lands in the block when the term is still there, whatever its casing", () => {
    const doc = docOf("Cold iron.", "Elara waited by the gate.");

    expect(resolvePassage(doc, blockSpan(doc, 1), "elara")).toEqual({
      kind: "block",
      ranges: [{ from: 13, to: 18 }],
    });
  });

  it("marks every occurrence inside the block, and nothing outside it", () => {
    const doc = docOf("Elara left.", "Elara stayed, and Elara waited.");
    const resolved = resolvePassage(doc, blockSpan(doc, 1), "elara");

    expect(resolved.kind).toBe("block");
    expect(resolved.kind === "block" && resolved.ranges).toHaveLength(2);
    expect(resolved.kind === "block" && resolved.ranges[0].from).toBeGreaterThan(13);
  });

  it("survives an edit inside the block, because the block still holds the term", () => {
    const doc = docOf("Cold iron.", "Elara waited a long while by the gate.");

    expect(resolvePassage(doc, blockSpan(doc, 1), "elara").kind).toBe("block");
  });

  it("re-finds the term when its block is gone and the document holds it once", () => {
    const doc = docOf("Cold iron.", "Elara waited by the gate.");

    expect(resolvePassage(doc, null, "elara")).toEqual({
      kind: "refound",
      ranges: [{ from: 13, to: 18 }],
    });
  });

  it("re-finds the term when the block survived but no longer contains it", () => {
    const doc = docOf("She waited by the gate.", "Elara went north.");

    expect(resolvePassage(doc, blockSpan(doc, 0), "elara").kind).toBe("refound");
  });

  it("refuses to choose between duplicates", () => {
    const doc = docOf("Elara went north.", "Elara went south.");

    expect(resolvePassage(doc, null, "elara")).toEqual({ kind: "stale" });
  });

  it("says stale rather than landing anywhere when the term is gone", () => {
    const doc = docOf("She went north.");

    expect(resolvePassage(doc, blockSpan(doc, 0), "elara")).toEqual({ kind: "stale" });
    expect(resolvePassage(doc, null, "")).toEqual({ kind: "stale" });
  });

  it("refuses a term that only reads as contiguous across a hard break", () => {
    // "gate" ⏎ "keeper" is not the word "gatekeeper". The server matched real
    // text; inventing one here would land the writer on a passage that never
    // contained what they searched for.
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("gate"),
        schema.node("hard_break"),
        schema.text("keeper"),
      ]),
    ]);

    expect(resolvePassage(doc, blockSpan(doc, 0), "gatekeeper")).toEqual({ kind: "stale" });
    expect(resolvePassage(doc, null, "gatekeeper")).toEqual({ kind: "stale" });
  });

  it("refuses a term that only reads as contiguous across an inline image", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("gate"),
        schema.node("image", { src: "vale.png" }),
        schema.text("keeper"),
      ]),
    ]);

    expect(resolvePassage(doc, blockSpan(doc, 0), "gatekeeper")).toEqual({ kind: "stale" });
  });

  it("still finds a term that sits wholly inside one run", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("the gate"),
        schema.node("hard_break"),
        schema.text("stood open"),
      ]),
    ]);

    expect(resolvePassage(doc, blockSpan(doc, 0), "stood")).toEqual({
      kind: "block",
      ranges: [{ from: 10, to: 15 }],
    });
  });

  it("keeps ranges on real characters when lowercasing changes length", () => {
    // "İ".toLowerCase() is two code units, so folded offsets are not source
    // offsets. Indexing source positions with folded ones drops the match.
    const doc = docOf("İstanbul was far from the vale.");
    const resolved = resolvePassage(doc, blockSpan(doc, 0), "İstanbul");

    expect(resolved.kind).toBe("block");
    expect(resolved.kind === "block" && resolved.ranges).toEqual([{ from: 1, to: 9 }]);
    expect(doc.textBetween(1, 9)).toBe("İstanbul");
  });

  it("folds the way the server does, where a letter's case depends on its neighbours", () => {
    // "ΟΣ".toLowerCase() ends in a final sigma, "ος". Folding character by
    // character yields "οσ" instead, which misses the word the writer searched
    // and still matches the "ος" inside "πύργος" — leaving the mark on a
    // different word. Both occurrences are real; the first one is the point.
    const doc = docOf("ΟΣ πύργος έπεσε.");
    const resolved = resolvePassage(doc, blockSpan(doc, 0), "ΟΣ");

    expect(resolved.kind).toBe("block");
    expect(resolved.kind === "block" && resolved.ranges).toEqual([
      { from: 1, to: 3 },
      { from: 8, to: 10 },
    ]);
    expect(doc.textBetween(1, 3)).toBe("ΟΣ");
  });

  it("says stale when only contextual folding would have matched", () => {
    // Nothing else in this sentence folds to "ος", so per-character folding
    // finds nothing at all and the ladder would wrongly report the passage
    // gone while it sits in plain sight.
    const doc = docOf("ΟΣ πύργοι έπεσαν.");
    const resolved = resolvePassage(doc, blockSpan(doc, 0), "ΟΣ");

    expect(resolved.kind).toBe("block");
    expect(resolved.kind === "block" && resolved.ranges).toEqual([{ from: 1, to: 3 }]);
  });

  it("folds a term that ends at a run boundary", () => {
    // The break makes "ΟΣ" a run of its own, so its sigma is final there too.
    // Folding granularity is the bug class, so the boundary gets its own case.
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("ΟΣ"),
        schema.node("hard_break"),
        schema.text("ΤΑ"),
      ]),
    ]);
    const resolved = resolvePassage(doc, blockSpan(doc, 0), "ΟΣ");

    expect(resolved.kind).toBe("block");
    expect(resolved.kind === "block" && resolved.ranges).toEqual([{ from: 1, to: 3 }]);
  });

  it("keeps positions honest across mark boundaries", () => {
    // Marks split one sentence into several text nodes; reading textContent
    // would still line up, but reading it per node would not.
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("The "),
        schema.text("gate", [schema.marks.em.create()]),
        schema.text(" stood open."),
      ]),
    ]);
    const resolved = resolvePassage(doc, blockSpan(doc, 0), "gate stood");

    expect(resolved.kind).toBe("block");
    expect(resolved.kind === "block" && resolved.ranges).toEqual([{ from: 5, to: 15 }]);
  });
});
