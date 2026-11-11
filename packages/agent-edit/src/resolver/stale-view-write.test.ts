/**
 * Guards the invariant "Text converges" (`.context/invariants.md`): a write planned on a
 * stale view lands whole after someone deleted text it shares words with. The server plans
 * a reply's write on the model's view and merges the update into the current room, which is
 * what this test does with two Yjs docs. A delete the room already holds when the write
 * plans is lowered around (`current`); one that arrives after relies on find windows.
 */

import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { applyEdits } from "../apply/apply-edits.js";
import { createAgentEditCodecFactory } from "../codec-adapter.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { type ResolveWriteParams, resolveWrite } from "./resolve.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);
const model = yProsemirrorModel(schema);
const LINE = " DRAFT-B line.";

const findInsert = { command: "insert", find: "disciple.", content: " DRAFT-B2." } as const;
const findReplace = { command: "replace", find: "disciple.", content: "disciple. DRAFT-B2." };
const rewrite = (markdown: string) =>
  ({ command: "replace", wholeDocument: true, content: markdown }) as const;

it.each([
  ["a find insert, deleted after planning", "", findInsert, "after"],
  ["a find replace, deleted after planning", "", findReplace, "after"],
  ["a find insert", "", findInsert, "before"],
  ["a rewrite", "", rewrite("A disciple. DRAFT-B2. SIDETEXT"), "before"],
  ["a rewrite that inserts", "", rewrite(`A disciple. DRAFT-B2.${LINE} SIDETEXT`), "before"],
  ["a find insert into a quote", "> ", findInsert, "before"],
  ["a rewrite of a list item", "- ", rewrite("- A disciple. DRAFT-B2. SIDETEXT"), "before"],
] as const)("lands %s whole", (_, prefix, write, deleted) => {
  const room = new Y.Doc({ gc: false });
  room.clientID = 1;
  prosemirrorToYXmlFragment(
    schema.node("doc", null, codec.parse(`${prefix}A disciple.${LINE} SIDETEXT`).blocks),
    room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
  );
  const view = new Y.Doc({ gc: false });
  view.clientID = 2;
  Y.applyUpdate(view, Y.encodeStateAsUpdate(room));
  const seen = Y.encodeStateVector(view);
  const deleteLine = () => {
    const block = model.getBlocks(room)[0];
    const from = model.getText(block).indexOf(LINE);
    model.applyTextEdit(room, block, { from, to: from + LINE.length }, "");
  };

  if (deleted === "before") deleteLine();
  const resolved = resolveWrite(
    {
      doc: view,
      model,
      codec,
      links: "preassigned",
      ...(deleted === "before" ? { current: room } : {}),
    },
    {
      documentAddress: { documentId: "123e4567-e89b-12d3-a456-426614174000", filePath: "c.md" },
      ...write,
    } as ResolveWriteParams,
  );
  if (!resolved.ok) throw new Error(resolved.error.message);
  applyEdits(view, model, resolved.edits, { type: "agent", actorTurnId: "turn-1" });
  if (deleted === "after") deleteLine();
  Y.applyUpdate(room, Y.encodeStateAsUpdate(view, seen));

  expect(model.getText(model.getBlocks(room)[0])).toBe("A disciple. DRAFT-B2. SIDETEXT");
});
