/**
 * What an AI edit's changes are in a text (Undo, byline and card), run on blocks and Yjs
 * replicas with no database. Each case is a risk the single-truth review found.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - An Undo is a recorded event: a part it took reads out and holds no pending change, whatever the text later says (kb/wiki/architecture/collaboration/agent-editing-and-reversal.md#reversal-is-a-forward-edit)
 */
import { captureDelta, type StoredDelta } from "@meridian/agent-edit/content-merge";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { draftSchema, isPending, readChangesAt, takeBack } from "./draft-changes.js";

const paragraphs = (...texts: string[]): PMNode[] =>
  texts.map((text, index) =>
    draftSchema.nodes.paragraph.create({ id: `p${index}` }, text ? draftSchema.text(text) : null),
  );
const words = (blocks: readonly PMNode[]) => blocks.map((block) => block.textContent);
const delta = (before: PMNode[], after: PMNode[]) => captureDelta(before, after) as StoredDelta;

describe("an AI edit's Undo in the manuscript", () => {
  const before = paragraphs("The cat sat on the mat.", "The door stayed shut.");
  const after = paragraphs("The tiger sat on the mat.", "The door stayed shut.");
  const part = { delta: delta(before, after) };
  const retype = (text: string) => paragraphs(text, "The door stayed shut.");

  it("takes out only the AI's words when the writer typed beside them", () => {
    const typed = retype("Then the tiger sat on the mat, purring.");
    const undone = takeBack(typed, [part]);
    expect(words(undone.live)).toEqual([
      "Then the cat sat on the mat, purring.",
      "The door stayed shut.",
    ]);
    expect(undone.taken).toEqual([part]);
  });

  it("does nothing when the writer typed inside them", () => {
    const typed = retype("The tigxer sat on the mat.");
    const undone = takeBack(typed, [part]);
    expect(words(undone.live)).toEqual(words(typed));
    expect(undone.taken).toEqual([]);
  });
});

describe("a part an Undo took", () => {
  const original = paragraphs("Lin Feng woke to the smell of burnt incense.");
  const replaced = (text: string) => paragraphs(`Lin Feng woke to the smell of ${text}.`);
  const reading = (text: PMNode[], ...parts: Parameters<typeof readChangesAt>[2][number][]) =>
    readChangesAt(original, text, parts);

  it("is not claimed by a later reply's different change in the same sentence", () => {
    const first = { id: 1001, delta: delta(original, replaced("silver rain")), taken: true };
    const second = { id: 1002, delta: delta(original, replaced("golden dust")) };
    const { parts } = reading(replaced("golden dust"), first, second);
    expect(parts.get(1001)?.changes.map((c) => [c.state, c.sitsIn.size])).toEqual([["out", 0]]);
    expect(parts.get(1002)?.changes.map(isPending)).toEqual([true]);
  });

  it("is not claimed by a later reply that proposes the very same change", () => {
    const first = { id: 1001, delta: delta(original, replaced("silver rain")), taken: true };
    const second = { id: 1002, delta: delta(original, replaced("silver rain")) };
    const { parts } = reading(replaced("silver rain"), first, second);
    expect(parts.get(1001)?.changes.map(isPending)).toEqual([false]);
    expect(parts.get(1002)?.changes.map(isPending)).toEqual([true]);
  });
});

describe("a hand edit in another paragraph", () => {
  it("is not read as the AI's change", () => {
    const base = paragraphs("The tiger slept.", "Rain fell all night.", "The tiger woke.");
    const ai = paragraphs("The cat slept.", "Rain fell all night.", "The tiger woke.");
    // The writer made the same word change by hand two paragraphs down, adding a word.
    const text = paragraphs("The cat slept.", "Rain fell all night.", "The cat woke up.");
    const { reading, parts } = readChangesAt(base, text, [{ id: 3001, delta: delta(base, ai) }]);
    expect(reading.pending.groups).toHaveLength(2);
    const sitsIn = [...(parts.get(3001)?.changes[0].sitsIn ?? [])];
    expect(sitsIn).toHaveLength(1);
    expect(reading.pending.groups[sitsIn[0]].excerpt.inserted).toContain("cat");
  });
});
