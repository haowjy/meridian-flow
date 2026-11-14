/**
 * Guards the invariant "Text converges" (`.context/invariants.md`): a write planned on a
 * stale view lands after someone deleted text it shares words with. A deleted letter comes
 * back only inside the model's own whole new text. The server plans a reply's write on the model's view
 * and merges the update into the current room, which is what this test does with two Yjs
 * docs. Every row runs with the model's client id below and above the writer's, since Yjs
 * orders concurrent inserts at one place by client id.
 *
 * A block the write edits keeps its element and its id, however the model changed it (a table
 * that gains a row, a line break in the middle of a paragraph): the merge and review pair
 * blocks by id. A word the model changes is the unit it lands, so a phrase the writer cut from
 * an unspaced clause stays cut when the model changes another word of it.
 *
 * Pins implementation decisions: the write never reads the room. A replace deletes only the
 * units the room still holds and inserts the model's whole new text after them, with no trim
 * of the edges the old and new text share (owner's decision, "the AI's whole word"), so a
 * word the writer deleted and the model's text repeats comes back with it, and odd merges
 * such as `He sighedthen he cried.` are accepted: the model is trusted to notice a mangled
 * merge in the echo (`write-architecture.md`).
 */

import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import {
  buildDocumentSchema,
  PROSEMIRROR_FRAGMENT_NAME,
  withBlockIds,
} from "@meridian/prosemirror-schema";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { expect, it } from "vitest";
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
  ["a find insert", TEXT, findInsert, deleteLine, WHOLE],
  ["a find replace", TEXT, findReplace, deleteLine, WHOLE],
  [
    "a find insert whose match ends inside the deleted run",
    TEXT,
    { command: "insert", find: "A disciple. ", content: "DRAFT-B2." },
    deleteText("DRAFT-B line. "),
    "A disciple. DRAFT-B2.SIDETEXT",
  ],
  [
    "a find insert beside a deleted Chinese sentence",
    "师父说：走吧。DRAFT-B行。旁白",
    { command: "insert", find: "走吧。", content: "DRAFT-B2。" },
    deleteText("DRAFT-B行。"),
    "师父说：走吧。DRAFT-B2。旁白",
  ],
  [
    "a rewrite that inserts, placed by the word diff where the writer cut the line",
    TEXT,
    rewrite(`A disciple. DRAFT-B2.${LINE} SIDETEXT`),
    deleteLine,
    "A disciple.B2. DRAFT- SIDETEXT",
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
    `WRITER ${WHOLE}`,
  ],
  [
    "the model's whole new text for a change to text the writer deleted",
    TEXT,
    { command: "replace", find: "DRAFT-B line.", content: "DRAFT-B3 line." },
    deleteLine,
    "A disciple.DRAFT-B3 line. SIDETEXT",
  ],
  [
    "a find insert after a word the writer deleted",
    "the slowly moving train",
    { command: "insert", find: "slowly", content: ", steadily" },
    deleteText(" slowly"),
    "the, steadily moving train",
  ],
  [
    "the model's whole polished sentence, which the writer had cut",
    KEEP,
    {
      command: "replace",
      find: KEEP,
      content: "Keep this. Cut sentence there, polished. Keep end.",
    },
    deleteText("Cut sentence there. "),
    "Keep this. Cut sentence there, polished. Keep end.",
  ],
  [
    "the model's changed Chinese word, with a phrase the writer cut elsewhere in the clause",
    "他慢慢地走了出去，天黑了。",
    rewrite("他慢慢地跑了出去，天黑了。"),
    deleteText("慢慢地"),
    "他跑了出去，天黑了。",
  ],
  [
    "a table row the model adds, with the writer typing in a cell",
    "| a | b |\n| --- | --- |\n| one | two |",
    rewrite("| a | b |\n| --- | --- |\n| one | two |\n| three | four |"),
    retype("a", "a W"),
    [
      "<table>",
      "  <thead>",
      "    <tr>",
      "      <th>",
      "        <p>a W</p>",
      "      </th>",
      "      <th>",
      "        <p>b</p>",
      "      </th>",
      "    </tr>",
      "  </thead>",
      "  <tbody>",
      "    <tr>",
      "      <td>",
      "        <p>one</p>",
      "      </td>",
      "      <td>",
      "        <p>two</p>",
      "      </td>",
      "    </tr>",
      "    <tr>",
      "      <td>",
      "        <p>three</p>",
      "      </td>",
      "      <td>",
      "        <p>four</p>",
      "      </td>",
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n"),
  ],
  [
    "a line break the model puts into a paragraph, with the writer typing in its head",
    "Line one and more words.",
    rewrite("Line one\\\nand more words."),
    retype("one", "one W"),
    "Line one W\\\nand more words.",
  ],
  [
    "bold across a passage the writer cut from",
    "Keep this. Cut it. Keep end.",
    rewrite("Keep **this. Cut it. Keep** end."),
    deleteText("Cut it. "),
    "Keep **this. Keep** end.",
  ],
  [
    "a word changed before text the writer typed over",
    SIGHED,
    { command: "replace", find: "sighed", content: "groaned" },
    retype(", and then he wept", " loudly"),
    "He groaned loudly.",
  ],
  [
    "bold on a word before text the writer typed over",
    SIGHED,
    rewrite("He **sighed**, and then he wept."),
    retype(", and then he wept", " loudly"),
    "He **sighed** loudly.",
  ],
  [
    "a word changed in a quote before text the writer typed over",
    `> ${SIGHED}`,
    { command: "replace", find: "sighed", content: "wept" },
    retype(", and then he wept", " loudly"),
    "> He wept loudly.",
  ],
  [
    "a word changed in a list item before text the writer typed over",
    `- ${SIGHED}`,
    { command: "replace", find: "sighed", content: "wept" },
    retype(", and then he wept", " loudly"),
    "- He wept loudly.",
  ],
] as const)("lands %s", (_, markdown, write, writer, expected) => {
  for (const modelClient of [2, 4]) {
    const room = new Y.Doc({ gc: false });
    room.clientID = 1;
    prosemirrorToYXmlFragment(
      schema.node(
        "doc",
        null,
        codec.parse(markdown).blocks.map((block) => withBlockIds(block)),
      ),
      room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    );
    const view = new Y.Doc({ gc: false });
    view.clientID = modelClient;
    Y.applyUpdate(view, Y.encodeStateAsUpdate(room));
    const seen = Y.encodeStateVector(view);
    room.clientID = 3;
    const fragment = room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    const ids = () => fragment.toArray().map((block) => (block as Y.XmlElement).getAttribute("id"));
    const idsBefore = ids();

    writer(room);
    const resolved = resolveWrite(
      {
        doc: view,
        model,
        codec,
        links: "preassigned",
      },
      {
        documentAddress: { documentId: "123e4567-e89b-12d3-a456-426614174000", filePath: "c.md" },
        ...write,
      } as ResolveWriteParams,
    );
    if (!resolved.ok) throw new Error(resolved.error.message);
    applyEdits(view, model, resolved.edits, { type: "agent", actorTurnId: "turn-1" });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(view, seen));

    const blocks = model.projectBlocks(room).map((block) => block.node);
    expect(codec.serialize(blocks).trim(), `model client ${modelClient}`).toBe(expected);
    expect(ids(), `model client ${modelClient}: block ids`).toEqual(idsBefore);
  }
});
