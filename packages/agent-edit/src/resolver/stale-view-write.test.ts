/**
 * Guards the invariant "Text converges" (`.context/invariants.md`): a write planned on a
 * stale view of a plain paragraph lands whole after someone deleted text it shares words
 * with, and the writer's delete stands. The server plans a reply's write on the model's view and merges the update
 * into the current room, which is what this test does with two Yjs docs. A delete the room
 * already holds when the write plans is decided against (`current`); one that arrives after
 * relies on find windows. Every row runs with the model's client id below and above the
 * writer's, since Yjs orders concurrent inserts at one place by client id.
 *
 * Pins implementation decisions: a model change to text the writer has since deleted is
 * skipped; a block that is not flat text is lowered as without a room (`write-architecture.md`). The quote and list
 * rows give `main`'s result.
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

const findInsert = { command: "insert", find: "disciple.", content: " DRAFT-B2." } as const;
const findReplace = { command: "replace", find: "disciple.", content: "disciple. DRAFT-B2." };
const rewrite = (markdown: string) =>
  ({ command: "replace", wholeDocument: true, content: markdown }) as const;
const deleteLine = deleteText(LINE);
/** The writer selecting `old` and typing `text` in the browser: a delete, then one insert per key. */
const retype =
  (old: string, text: string): Writer =>
  (room) => {
    let ytext = room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0);
    while (!(ytext instanceof Y.XmlText)) ytext = (ytext as Y.XmlElement).get(0);
    const from = ytext.toString().indexOf(old);
    ytext.delete(from, old.length);
    for (const [index, char] of [...text].entries()) ytext.insert(from + index, char);
  };
const KEEP = "Keep this. Cut sentence there. Keep end.";
const SIGHED = "He sighed, and then he wept.";

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
    "nothing of a change to text the writer deleted",
    TEXT,
    { command: "replace", find: "DRAFT-B line.", content: "DRAFT-B3 line." },
    deleteLine,
    "before",
    "A disciple. SIDETEXT",
  ],
  [
    "a find insert after a word the writer deleted",
    "the slowly moving train",
    { command: "insert", find: "slowly", content: ", steadily" },
    deleteText(" slowly"),
    "before",
    "the moving train",
  ],
  [
    "nothing of a find's polish of a sentence the writer cut",
    KEEP,
    {
      command: "replace",
      find: KEEP,
      content: "Keep this. Cut sentence there, polished. Keep end.",
    },
    deleteText("Cut sentence there. "),
    "before",
    "Keep this. Keep end.",
  ],
  [
    "one character of a Chinese clause the writer cut a phrase from",
    "他慢慢地走了出去，天黑了。",
    rewrite("他慢慢地跑了出去，天黑了。"),
    deleteText("慢慢地"),
    "before",
    "他跑了出去，天黑了。",
  ],
  [
    "bold across a passage the writer cut from",
    "Keep this. Cut it. Keep end.",
    rewrite("Keep **this. Cut it. Keep** end."),
    deleteText("Cut it. "),
    "before",
    "Keep **this. Keep** end.",
  ],
  [
    "a word changed before text the writer typed over",
    SIGHED,
    { command: "replace", find: "sighed", content: "groaned" },
    retype(", and then he wept", " loudly"),
    "before",
    "He groaned loudly.",
  ],
  [
    "bold on a word before text the writer typed over",
    SIGHED,
    rewrite("He **sighed**, and then he wept."),
    retype(", and then he wept", " loudly"),
    "before",
    "He **sighed** loudly.",
  ],
  [
    "a word changed in a quote before text the writer typed over, as on main",
    `> ${SIGHED}`,
    { command: "replace", find: "sighed", content: "wept" },
    retype(", and then he wept", " loudly"),
    "before",
    "> He wept loudly.",
  ],
  [
    "a word changed in a list item before text the writer typed over, as on main",
    `- ${SIGHED}`,
    { command: "replace", find: "sighed", content: "wept" },
    retype(", and then he wept", " loudly"),
    "before",
    "- He wept loudly.",
  ],
] as const)("lands %s", (_, markdown, write, writer, deleted, expected) => {
  for (const modelClient of [2, 4]) {
    const room = new Y.Doc({ gc: false });
    room.clientID = 1;
    prosemirrorToYXmlFragment(
      schema.node("doc", null, codec.parse(markdown).blocks),
      room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    );
    const view = new Y.Doc({ gc: false });
    view.clientID = modelClient;
    Y.applyUpdate(view, Y.encodeStateAsUpdate(room));
    const seen = Y.encodeStateVector(view);
    room.clientID = 3;

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
    expect(codec.serialize(blocks).trim(), `model client ${modelClient}`).toBe(expected);
  }
});
