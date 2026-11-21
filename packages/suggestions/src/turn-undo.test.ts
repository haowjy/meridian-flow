/**
 * Card Undo of a later AI reply that rewrote an earlier reply's pending text gives the earlier
 * wording back, inside a paragraph the AI added as well as in a Live one.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - A later turn's edit over an earlier turn's text layers instead of replacing it, and `kindOf`
 *   honours the draft's own deletion inside its own added block (packages/suggestions/.context/CONTEXT.md, "Writing: `rewrite`").
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { expect, it } from "vitest";
import { type Author, recordStarted, reject, rewrite, type View, viewBlock } from "./index.js";

const schema = buildDocumentSchema();
const view: View = { draft: "draft-1" };
const authors = new Map<string, Author>();
const reply = (turn: string) => ({ chat: "chat-1", turn, by: "agent" });
const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));

function suggest(state: EditorState, turn: string, edit: (tr: Transaction) => void) {
  const tr = state.tr;
  edit(tr);
  const out = rewrite(tr, state, view, reply(turn), authors);
  recordStarted(out, authors);
  return state.apply(out);
}

function shown(doc: Node): string[] {
  const texts: string[] = [];
  doc.forEach((block) => {
    const seen = viewBlock(block, view);
    if (seen) texts.push(seen.textContent);
  });
  return texts;
}

it("Undo of reply 2 brings back reply 1's word in the paragraph reply 1 added", () => {
  let state = EditorState.create({
    schema,
    doc: schema.topNodeType.create(null, [paragraph("Live one is here.")]),
  });
  state = suggest(state, "turn-1", (tr) =>
    tr.insert(tr.doc.content.size, paragraph("The silver boat drifts.")),
  );
  const added = state.doc.child(1);
  const silver = state.doc.child(0).nodeSize + 1 + added.textContent.indexOf("silver");
  state = suggest(state, "turn-2", (tr) =>
    tr.replaceWith(silver, silver + "silver".length, schema.text("golden")),
  );
  expect(shown(state.doc)).toEqual(["Live one is here.", "The golden boat drifts."]);

  state = state.apply(reject(state, { turn: "turn-2" }, authors));

  expect(shown(state.doc)).toEqual(["Live one is here.", "The silver boat drifts."]);
  expect(shown(state.apply(reject(state, { turn: "turn-1" }, authors)).doc)).toEqual([
    "Live one is here.",
  ]);
});
