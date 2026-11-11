/**
 * Guards the invariant "Text converges" (`.context/invariants.md`): a write planned on a
 * stale view lands whole after someone deleted text it shares words with, and the writer's
 * delete stands. The server plans a reply's write on the model's view and merges the update
 * into the current room, which is what this test does with two Yjs docs. A delete the room
 * already holds when the write plans is lowered around (`current`); one that arrives after
 * relies on find windows.
 *
 * Pins implementation decisions: a model change to text the writer has since deleted is
 * skipped (`write-architecture.md`).
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
const TEXT = `A disciple.${LINE} SIDETEXT`;
const WHOLE = "A disciple. DRAFT-B2. SIDETEXT";

type Writer = (room: Y.Doc) => void;
const deleteText =
  (text: string): Writer =>
  (room) => {
    const block = model.getBlocks(room)[0];
    const from = model.getText(block).indexOf(text);
    model.applyTextEdit(room, block, { from, to: from + text.length }, "");
  };
/** The writer's editor turning the block into `markdown`, as y-prosemirror syncs it. */
const editTo =
  (markdown: string): Writer =>
  (room) =>
    model.applyBlockReplacement(room, model.getBlocks(room)[0], codec.parse(markdown).blocks[0]);

const findInsert = { command: "insert", find: "disciple.", content: " DRAFT-B2." } as const;
const findReplace = { command: "replace", find: "disciple.", content: "disciple. DRAFT-B2." };
const rewrite = (markdown: string) =>
  ({ command: "replace", wholeDocument: true, content: markdown }) as const;
const deleteLine = deleteText(LINE);

it.each([
  ["a find insert, deleted after planning", TEXT, findInsert, deleteLine, "after", WHOLE],
  ["a find replace, deleted after planning", TEXT, findReplace, deleteLine, "after", WHOLE],
  ["a find insert", TEXT, findInsert, deleteLine, "before", WHOLE],
  [
    "a find insert whose match ends inside the deleted run",
    TEXT,
    { command: "insert", find: "A disciple. ", content: "DRAFT-B2." },
    deleteText("DRAFT-B line. "),
    "before",
    "A disciple. DRAFT-B2.SIDETEXT",
  ],
  [
    "a find insert beside a deleted Chinese sentence",
    "师父说：走吧。DRAFT-B行。旁白",
    { command: "insert", find: "走吧。", content: "DRAFT-B2。" },
    deleteText("DRAFT-B行。"),
    "before",
    "师父说：走吧。DRAFT-B2。旁白",
  ],
  [
    "a rewrite that inserts",
    TEXT,
    rewrite(`A disciple. DRAFT-B2.${LINE} SIDETEXT`),
    deleteLine,
    "before",
    WHOLE,
  ],
  ["a find insert into a quote", `> ${TEXT}`, findInsert, deleteLine, "before", `> ${WHOLE}`],
  [
    "a rewrite of a list item that inserts",
    `- ${TEXT}`,
    rewrite(`- A disciple. DRAFT-B2.${LINE} SIDETEXT`),
    deleteLine,
    "before",
    `- ${WHOLE}`,
  ],
  [
    "a find insert beside the writer's new words",
    TEXT,
    findInsert,
    (room: Y.Doc) => {
      deleteLine(room);
      const block = model.getBlocks(room)[0];
      model.applyTextEdit(room, block, { from: 0, to: 0 }, "WRITER ");
    },
    "before",
    `WRITER ${WHOLE}`,
  ],
  [
    "a change to verse after the writer deleted a line",
    "Line one\\\nLine two\\\nLine three",
    { command: "replace", find: "three", content: "3" },
    editTo("Line one\\\nLine three"),
    "before",
    "Line one\\\nLine 3",
  ],
  [
    "nothing of a change to text the writer deleted",
    TEXT,
    { command: "replace", find: "DRAFT-B line.", content: "DRAFT-B3 line." },
    deleteLine,
    "before",
    "A disciple. SIDETEXT",
  ],
] as const)("lands %s", (_, markdown, write, writer, deleted, expected) => {
  const room = new Y.Doc({ gc: false });
  room.clientID = 1;
  prosemirrorToYXmlFragment(
    schema.node("doc", null, codec.parse(markdown).blocks),
    room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
  );
  const view = new Y.Doc({ gc: false });
  view.clientID = 2;
  Y.applyUpdate(view, Y.encodeStateAsUpdate(room));
  const seen = Y.encodeStateVector(view);

  if (deleted === "before") writer(room);
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
  if (deleted === "after") writer(room);
  Y.applyUpdate(room, Y.encodeStateAsUpdate(view, seen));

  const blocks = model.projectBlocks(room).map((block) => block.node);
  expect(codec.serialize(blocks).trim()).toBe(expected);
});
