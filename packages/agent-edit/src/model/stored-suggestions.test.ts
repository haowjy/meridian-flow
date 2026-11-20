/**
 * A resolve writes only what it settles: text typed inside a word a press resolved stays where it
 * was typed when the press is taken back. Before the resolve was lowered exactly, the press's text
 * was rewritten and Undo moved the typing to after the word.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - `resolveStored` lowers a verdict through its transaction's mapping (`lowerResolved`), and the
 *   press's Undo is a Yjs undo of the press's stored id ranges (packages/suggestions/.context/CONTEXT.md, "Resolving").
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { viewBlock } from "@meridian/suggestions";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { toDocHandle } from "../handles.js";
import { lowerBlock } from "../resolver/lower-block.js";
import { pressStored, undoPressStored } from "./stored-suggestions.js";
import { suggestingModel } from "./suggesting-model.js";
import { fragmentOf, yProsemirrorModel } from "./y-prosemirror.js";

const schema = buildDocumentSchema();
const work = "work-1";

/** A one-paragraph document whose paragraph the AI rewrote as `rewritten` in the Work's view. */
function suggested(text: string, rewritten: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  const paragraph = { type: "paragraph", content: [{ type: "text", text }] };
  prosemirrorJSONToYXmlFragment(schema, { type: "doc", content: [paragraph] }, fragmentOf(doc));
  const model = suggestingModel(
    yProsemirrorModel(schema),
    { work },
    {
      chat: "chat-1",
      turn: "turn-1",
      by: "agent",
    },
  );
  const handle = toDocHandle(doc);
  doc.transact(() => {
    const [shown] = model.projectBlocks(handle);
    const next = schema.nodes.paragraph.create(shown.node.attrs, schema.text(rewritten));
    model.applyOps(handle, model.getBlocks(handle)[0], lowerBlock(shown.node, next));
  });
  return doc;
}

function read(doc: Y.Doc, view: string | null): string {
  const root = yXmlFragmentToProseMirrorRootNode(fragmentOf(doc), schema);
  return viewBlock(root.child(0), { work: view })?.textContent ?? "";
}

/** The writer types `typed` into the paragraph's text before the first `before`. */
function type(doc: Y.Doc, before: string, typed: string): void {
  const text = (fragmentOf(doc).get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const plain = (text.toDelta() as Array<{ insert: string }>).map((run) => run.insert).join("");
  text.insert(plain.indexOf(before), typed);
}

it("a press's Undo leaves text typed inside a resolved word where it was typed", () => {
  const applied = suggested("Hello world, said Tom.", "Hello earth, said Tom.");
  const apply = pressStored(applied, schema, "accept", { work });
  type(applied, "rth", "?");
  expect(apply && undoPressStored(applied, apply)).toBe(true);
  expect(read(applied, work)).toBe("Hello ea?rth, said Tom.");

  const discarded = suggested("The cat sat on the mat.", "The dog sat on the rug.");
  const discard = pressStored(discarded, schema, "reject", { work });
  type(discarded, "at.", "X");
  expect(discard && undoPressStored(discarded, discard)).toBe(true);
  expect(read(discarded, null)).toBe("The cat sat on the mXat.");
});
