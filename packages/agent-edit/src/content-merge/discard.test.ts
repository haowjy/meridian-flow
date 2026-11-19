/**
 * A Discard names changes by the ids it read in the writer's text; the server applies it to a text
 * that may have moved on.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Ids name changes in the snapshot the click saw, and the result is merged into the current text
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { diffBlocks } from "../diff/hunks.js";
import { projectReview } from "../diff/review.js";
import { discardChanges } from "./discard.js";
import { parseDoc } from "./merge.fixtures.js";

const schema = buildDocumentSchema();
const doc = (src: string) => parseDoc(schema, src);
const words = (blocks: readonly PMNode[]) => blocks.map((block) => block.textContent);
const idsIn = (base: PMNode[], text: PMNode[]) =>
  projectReview(diffBlocks(base, text)).groups.map((group) => group.id);

describe("Discard", () => {
  const base = doc("p#a:The tiger slept. | p#b:Rain fell. | p#c:The gate opened.");
  const seen = doc("p#a:The cat slept. | p#b:Rain fell. | p#c:The gate opened.");

  it("takes the change the writer saw when typing arrived beside it since", () => {
    const [change] = idsIn(base, seen);
    const now = doc("p#a:The cat slept soundly. | p#b:Rain fell. | p#c:The gate opened.");
    const taken = discardChanges(schema, base, now, [change], { base, text: seen });
    expect(words(taken?.text ?? [])).toEqual([
      "The tiger slept soundly.",
      "Rain fell.",
      "The gate opened.",
    ]);
  });

  it("leaves a change the writer typed inside since", () => {
    const [change] = idsIn(base, seen);
    const now = doc("p#a:The caxt slept. | p#b:Rain fell. | p#c:The gate opened.");
    const taken = discardChanges(schema, base, now, [change], { base, text: seen });
    expect(words(taken?.text ?? now)).toEqual(words(now));
  });
});
