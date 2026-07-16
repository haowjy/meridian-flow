// ProseMirror mapping proofs for the semantic continuation seam.

import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import {
  lowerProseMirrorTransform,
  validateLoweredTargetPartition,
} from "./prosemirror-lowering.js";

const schema = buildDocumentSchema();
const root = (...children: PMNode[]) => schema.node("doc", null, children);
const paragraph = (text: string) => schema.node("paragraph", null, text ? schema.text(text) : []);
const source = (from: number, text: string, clock = 0) => ({
  source: { from, to: from + text.length },
  root: { clientID: 7, clock, length: text.length },
});

describe("ProseMirror semantic lowering", () => {
  it("preserves mapped prose across marks, structural split, and join", () => {
    const document = root(paragraph("abcd"));
    const marked = lowerProseMirrorTransform({
      document,
      continuations: [source(1, "abcd")],
      build(transform) {
        transform.addMark(1, 5, schema.marks.strong.create());
        transform.split(3);
        transform.join(4);
      },
    });
    expect(marked.document.textContent).toBe("abcd");
    expect(marked.continuations).toEqual([
      { target: { from: 1, to: 5 }, root: { clientID: 7, clock: 0, length: 4 } },
    ]);
  });

  it("preserves a ReplaceAroundStep gap but never a text-equal inserted slice", () => {
    const document = root(paragraph("one"), paragraph("two"));
    const lowered = lowerProseMirrorTransform({
      document,
      continuations: [source(1, "one", 0), source(6, "two", 3)],
      build(transform) {
        const range = transform.doc.resolve(1).blockRange(transform.doc.resolve(9));
        if (!range) throw new Error("missing wrap range");
        transform.wrap(range, [{ type: schema.nodes.blockquote }]);
      },
    });
    expect(lowered.transform.steps[0]?.constructor.name).toBe("ReplaceAroundStep");
    expect(lowered.continuations.flatMap((run) => run.root)).toEqual([
      { clientID: 7, clock: 0, length: 3 },
      { clientID: 7, clock: 3, length: 3 },
    ]);

    const replaced = lowerProseMirrorTransform({
      document: root(paragraph("same")),
      continuations: [source(1, "same")],
      build(transform) {
        transform.replaceWith(1, 5, schema.text("same"));
      },
    });
    expect(replaced.document.textContent).toBe("same");
    expect(replaced.continuations).toEqual([]);
  });

  it("maps around hard breaks and atoms and rejects overlap, omission, and extras", () => {
    const document = root(
      schema.node("paragraph", null, [
        schema.text("A"),
        schema.node("hard_break"),
        schema.node("image", { src: "https://example.test/dot.png", alt: "dot" }),
        schema.text("B"),
      ]),
    );
    const lowered = lowerProseMirrorTransform({
      document,
      continuations: [source(1, "A", 0), source(4, "B", 1)],
      build() {},
    });
    expect(lowered.continuations).toHaveLength(2);
    expect(() =>
      validateLoweredTargetPartition({
        visibleTargets: [
          { from: 1, to: 2 },
          { from: 4, to: 5 },
        ],
        claimedTargets: lowered.continuations.map((run) => run.target),
      }),
    ).not.toThrow();
    expect(() =>
      validateLoweredTargetPartition({
        visibleTargets: [{ from: 1, to: 3 }],
        claimedTargets: [{ from: 1, to: 2 }],
      }),
    ).toThrow(/unclaimed/);
    expect(() =>
      validateLoweredTargetPartition({
        visibleTargets: [{ from: 1, to: 3 }],
        claimedTargets: [
          { from: 1, to: 3 },
          { from: 2, to: 3 },
        ],
      }),
    ).toThrow(/overlap/);
  });

  it("handles two replacements without allowing either inserted match to inherit", () => {
    const document = root(paragraph("x x"));
    const lowered = lowerProseMirrorTransform({
      document,
      continuations: [source(1, "x x")],
      build(transform) {
        transform.replaceWith(3, 4, schema.text("y"));
        transform.replaceWith(1, 2, schema.text("y"));
      },
    });
    expect(lowered.document.textContent).toBe("y y");
    expect(lowered.continuations).toEqual([
      { target: { from: 2, to: 3 }, root: { clientID: 7, clock: 1, length: 1 } },
    ]);
  });

  it("maps surrogate pairs as one indivisible prose unit", () => {
    const document = root(paragraph("A😀B"));
    const lowered = lowerProseMirrorTransform({
      document,
      continuations: [source(1, "A😀B")],
      build(transform) {
        transform.insert(1, schema.text("x"));
      },
    });
    expect(lowered.continuations).toEqual([
      { target: { from: 2, to: 6 }, root: { clientID: 7, clock: 0, length: 4 } },
    ]);
  });
});
