/** The attribution's named risk: a writer-only change credited to a chat, or a chat named for text it did not write. */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { readBlocks } from "./fragments.js";
import { diffBlocks } from "./hunks.js";
import { projectReview } from "./review.js";
import {
  type AttributionEdit,
  editsInChanges,
  type ItemRange,
  matchAttribution,
} from "./yjs-attribution.js";

const schema = buildDocumentSchema();
const NAME = "prosemirror";

function peer(from: Y.Doc, clientID: number) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
  return doc;
}
const fragmentOf = (doc: Y.Doc) => doc.getXmlFragment(NAME);
const textOf = (doc: Y.Doc, block: number) =>
  (fragmentOf(doc).get(block) as Y.XmlElement).get(0) as Y.XmlText;

/** What a run inserted and deleted, as an edit part's item ranges. */
function ranges(doc: Y.Doc, run: () => void) {
  const before = Y.snapshot(doc).sv;
  const inserted: ItemRange[] = [];
  const deleted: ItemRange[] = [];
  const onTransaction = (tr: Y.Transaction) => {
    for (const [client, items] of tr.deleteSet.clients)
      for (const d of items) deleted.push([client, d.clock, d.len]);
  };
  doc.on("afterTransaction", onTransaction);
  run();
  doc.off("afterTransaction", onTransaction);
  for (const [client, clock] of Y.snapshot(doc).sv) {
    const from = before.get(client) ?? 0;
    if (clock > from) inserted.push([client, from, clock - from]);
  }
  return { inserted, deleted };
}

interface Write {
  chat: string;
  at: string;
  run: (doc: Y.Doc) => void;
}
interface Case {
  name: string;
  paragraphs: string[];
  ai: Write[];
  /** Apply: the review base takes the AI's text, so only the writer's edit afterwards is a change. */
  applied?: boolean;
  writer?: (doc: Y.Doc) => void;
  expect: { writer: boolean | undefined; chats: string[]; pending?: boolean[] };
}

const aiAt = (n: number) => `2026-10-13T1${n}:00:00Z`;

const CASES: Case[] = [
  {
    name: "an AI-only change names its chat, not the writer",
    paragraphs: ["alpha beta gamma delta"],
    ai: [{ chat: "A", at: aiAt(0), run: (d) => textOf(d, 0).insert(0, "zeta ") }],
    expect: { writer: false, chats: ["A"], pending: [true] },
  },
  {
    name: "two chats on one change: latest first",
    paragraphs: ["alpha beta"],
    ai: [
      { chat: "A", at: aiAt(0), run: (d) => textOf(d, 0).insert(textOf(d, 0).length, " omega") },
      { chat: "B", at: aiAt(1), run: (d) => textOf(d, 0).insert(0, "zeta ") },
    ],
    expect: { writer: false, chats: ["B", "A"] },
  },
  {
    name: "an AI deletion names its chat",
    paragraphs: ["one two three four five six"],
    ai: [{ chat: "C", at: aiAt(0), run: (d) => textOf(d, 0).delete(3, 4) }],
    expect: { writer: false, chats: ["C"] },
  },
  {
    name: "the writer's own typing names no chat",
    paragraphs: ["alpha beta gamma delta"],
    ai: [],
    writer: (d) => textOf(d, 0).insert(0, "WRITER "),
    expect: { writer: true, chats: [] },
  },
  {
    name: "a writer hunk near an AI hunk is one mixed change",
    paragraphs: ["alpha beta gamma delta epsilon zeta"],
    ai: [{ chat: "A", at: aiAt(0), run: (d) => textOf(d, 0).insert(0, "AI ") }],
    writer: (d) => textOf(d, 0).insert(textOf(d, 0).toString().indexOf("beta"), "WRITER "),
    expect: { writer: true, chats: ["A"] },
  },
  {
    name: "a distant writer edit after an applied AI deletion in the same paragraph",
    paragraphs: ["zero AIOLD one two three four five"],
    ai: [{ chat: "A", at: aiAt(0), run: (d) => textOf(d, 0).delete(5, 6) }],
    applied: true,
    writer: (d) => textOf(d, 0).insert(textOf(d, 0).length, " WRITER"),
    expect: { writer: true, chats: [], pending: [false] },
  },
  {
    name: "a letter the writer types inside an applied AI word",
    paragraphs: ["start tail words here"],
    ai: [{ chat: "A", at: aiAt(0), run: (d) => textOf(d, 0).insert(6, "MAGIC ") }],
    applied: true,
    writer: (d) => textOf(d, 0).insert(8, "x"),
    expect: { writer: true, chats: [] },
  },
  {
    name: "a block the writer deletes next to an applied AI block deletion",
    paragraphs: ["first block gone", "second block gone", "third block stays"],
    ai: [{ chat: "A", at: aiAt(0), run: (d) => fragmentOf(d).delete(0, 1) }],
    applied: true,
    writer: (d) => fragmentOf(d).delete(0, 1),
    expect: { writer: true, chats: [] },
  },
  {
    name: "repeated words never name the wrong chat",
    paragraphs: ["echo echo echo and then some filler words"],
    ai: [{ chat: "A", at: aiAt(0), run: (d) => textOf(d, 0).delete(10, 5) }],
    applied: true,
    writer: (d) => textOf(d, 0).delete(5, 5),
    expect: { writer: undefined, chats: [] },
  },
];

describe("attribution", () => {
  it.each(CASES)("$name", ({ paragraphs, ai, applied, writer, expect: want }) => {
    const seed = new Y.Doc();
    seed.clientID = 1;
    prosemirrorToYXmlFragment(
      schema.topNodeType.create(
        null,
        paragraphs.map((t) => schema.nodes.paragraph.create(null, schema.text(t))),
      ),
      fragmentOf(seed),
    );
    const draft = peer(seed, 9);
    const edits: AttributionEdit[] = [];
    ai.forEach((w, i) => {
      const doc = peer(draft, 2 + i);
      const { inserted, deleted } = ranges(doc, () => w.run(doc));
      edits.push({ threadId: w.chat, title: w.chat, turnId: `t${i}`, at: w.at, inserted, deleted });
      Y.applyUpdate(draft, Y.encodeStateAsUpdate(doc));
    });
    const base = readBlocks(fragmentOf(applied ? draft : seed), schema);
    if (writer) {
      const doc = peer(draft, 5);
      writer(doc);
      Y.applyUpdate(draft, Y.encodeStateAsUpdate(doc));
    }
    const projection = projectReview(diffBlocks(base, readBlocks(fragmentOf(draft), schema)));
    expect(projection.groups).toHaveLength(1);
    const got = matchAttribution(fragmentOf(draft), projection, edits).get(projection.groups[0].id);
    expect(got?.chats.map((c) => c.threadId) ?? []).toEqual(want.chats);
    if (want.writer !== undefined) expect(got?.writer).toBe(want.writer);
    if (want.pending)
      expect(editsInChanges(fragmentOf(draft), projection, edits)).toEqual(want.pending);
  });
});
