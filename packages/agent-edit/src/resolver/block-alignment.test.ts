/** Structural continuation must not depend on alignment's chosen split/merge piece. */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import { alignBlocks, type CanPair } from "./block-alignment.js";

const schema = buildDocumentSchema();
it.each([
  ["abcdefghijkl", ["abc", "de", "fghijkl"]],
  ["青山绿水长河天地", ["青山", "绿水", "长河天地"]],
  ["one two one three four five six", ["one two", "one", "three four five six"]],
] as const)("joins three-way split/merge with either head or tail paired: %s", (text, parts) => {
  const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
  const whole = [paragraph(text)],
    pieces = parts.map(paragraph);
  for (const paired of [0, pieces.length - 1]) {
    const split: CanPair = (_old, next) => next === pieces[paired];
    const merge: CanPair = (old, _next) => old === pieces[paired];
    for (const [before, after, canPair] of [
      [whole, pieces, split],
      [pieces, whole, merge],
    ] as const) {
      const steps = alignBlocks(before, after, canPair);
      expect(steps).toHaveLength(3);
      expect(steps[0].structuralBoundary).toBeDefined();
      expect(new Set(steps.map((step) => step.structuralBoundary)).size).toBe(1);
    }
  }
});
