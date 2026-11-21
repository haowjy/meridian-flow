/**
 * A resolve writes only what it settles: text typed inside a word a press resolved stays where it
 * was typed when the press is taken back. Before the resolve was lowered exactly, the press's text
 * was rewritten and Undo moved the typing to after the word.
 *
 * A model's planning view drops what the writer rejected since: the same rewrite asked for again
 * after a Discard is a new suggestion, not a write that matches the view and changes nothing.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - `resolveStored` lowers a verdict through its transaction's mapping (`lowerResolved`), and the
 *   press's Undo is a Yjs undo of the press's stored id ranges (packages/suggestions/.context/CONTEXT.md, "Resolving").
 * - `createPlanningView` takes rejected suggestions out by deleting their items (`withdrawRejected`).
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { viewBlock } from "@meridian/suggestions";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { createPlanningView } from "../frontier.js";
import { toDocHandle } from "../handles.js";
import { lowerBlock } from "../resolver/lower-block.js";
import { pressStored, undoPressStored } from "./stored-suggestions.js";
import { suggestingModel } from "./suggesting-model.js";
import { fragmentOf, yProsemirrorModel } from "./y-prosemirror.js";

const schema = buildDocumentSchema();
const draft = "draft-1";

/** A one-paragraph document whose paragraph the AI rewrote as `rewritten` in the Work's view. */
function suggested(text: string, rewritten: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  const paragraph = { type: "paragraph", content: [{ type: "text", text }] };
  prosemirrorJSONToYXmlFragment(schema, { type: "doc", content: [paragraph] }, fragmentOf(doc));
  rewrite(doc, rewritten);
  return doc;
}

/** The AI rewrites the paragraph as `text` in the Work's view. */
function rewrite(doc: Y.Doc, text: string): void {
  const model = suggestingModel(
    yProsemirrorModel(schema),
    { draft },
    {
      chat: "chat-1",
      turn: "turn-1",
      by: "agent",
    },
  );
  const handle = toDocHandle(doc);
  doc.transact(() => {
    const [shown] = model.projectBlocks(handle);
    const next = schema.nodes.paragraph.create(shown.node.attrs, schema.text(text));
    model.applyOps(handle, model.getBlocks(handle)[0], lowerBlock(shown.node, next));
  });
}

function read(doc: Y.Doc, view: string | null): string {
  const root = yXmlFragmentToProseMirrorRootNode(fragmentOf(doc), schema);
  return viewBlock(root.child(0), { draft: view })?.textContent ?? "";
}

/** The writer types `typed` into the paragraph's text before the first `before`. */
function type(doc: Y.Doc, before: string, typed: string): void {
  const text = (fragmentOf(doc).get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const plain = (text.toDelta() as Array<{ insert: string }>).map((run) => run.insert).join("");
  text.insert(plain.indexOf(before), typed);
}

it("a press's Undo leaves text typed inside a resolved word where it was typed", () => {
  const applied = suggested("Hello world, said Tom.", "Hello earth, said Tom.");
  const apply = pressStored(applied, schema, "accept", { draft });
  type(applied, "rth", "?");
  expect(apply && undoPressStored(applied, apply)).toBe(true);
  expect(read(applied, draft)).toBe("Hello ea?rth, said Tom.");

  const discarded = suggested("The cat sat on the mat.", "The dog sat on the rug.");
  const discard = pressStored(discarded, schema, "reject", { draft });
  type(discarded, "at.", "X");
  expect(discard && undoPressStored(discarded, discard)).toBe(true);
  expect(read(discarded, null)).toBe("The cat sat on the mXat.");
});

it("the same rewrite after a Discard plans as a new suggestion; after an Apply the view keeps it", () => {
  const discarded = suggested("The cat sat.", "The dog sat.");
  const shown = Y.snapshot(discarded);
  pressStored(discarded, schema, "reject", { draft });
  const view = createPlanningView(discarded, shown, []);
  expect(view && read(view, draft)).toBe("The cat sat.");
  const written: Uint8Array[] = [];
  view?.on("update", (update: Uint8Array) => written.push(update));
  if (view) rewrite(view, "The dog sat.");
  for (const update of written) Y.applyUpdate(discarded, update);
  expect(discarded.store.pendingStructs).toBeNull();
  expect([read(discarded, draft), read(discarded, null)]).toEqual(["The dog sat.", "The cat sat."]);

  const applied = suggested("The cat sat.", "The dog sat.");
  const seen = Y.snapshot(applied);
  pressStored(applied, schema, "accept", { draft });
  const kept = createPlanningView(applied, seen, []);
  expect(kept && read(kept, draft)).toBe("The dog sat.");

  // An Apply whose new word the writer then deleted is still an Apply: the struck word stays gone.
  const deleted = suggested("The cat sat.", "The dog sat.");
  const before = Y.snapshot(deleted);
  pressStored(deleted, schema, "accept", { draft });
  const text = (fragmentOf(deleted).get(0) as Y.XmlElement).get(0) as Y.XmlText;
  text.delete("The ".length, "dog ".length);
  const stale = createPlanningView(deleted, before, []);
  expect(stale && read(stale, draft)).toBe("The dog sat.");
});
