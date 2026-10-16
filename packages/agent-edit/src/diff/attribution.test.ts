/**
 * The attribution classifier's named risks, one table: a writer-only change credited to a chat, a chat
 * named for text it did not write, a chat dropped from a change it did write, and an AI part read as
 * applied while a change still holds it. Every row asserts byline and membership; the server suite checks real status.
 * Each row also runs on a gc-on reload of the draft, which has only what the draft itself carries (the
 * restoration links Undo recorded into it), and must give the same answer.
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { appendApplyRecord, readApplyRecord } from "./apply-record.js";
import {
  type AttributionPart,
  type Author,
  applyRecordOf,
  classifyChanges,
  type ItemRange,
} from "./attribution.js";
import { readBlocks } from "./fragments.js";
import { diffBlocks } from "./hunks.js";
import { rebase } from "./merge.js";
import { recordRestorations } from "./restorations.js";
import { projectReview } from "./review.js";
import { writeBlocks } from "./writer.js";

const schema = buildDocumentSchema();
const frag = (d: Y.Doc) => d.getXmlFragment("prosemirror");
const textOf = (d: Y.Doc, block = 0) => (frag(d).get(block) as Y.XmlElement).get(0) as Y.XmlText;
const para = (s: string) => schema.nodes.paragraph.create(null, s ? schema.text(s) : null);

function peer(from: Y.Doc, clientID: number, gc = false) {
  const doc = new Y.Doc({ gc });
  doc.clientID = clientID;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
  return doc;
}

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

/** A draft room under test: the seed is the base, AI writes and the writer's edits are peers merged in. */
function room(blocks: Array<string | PMNode>) {
  const seed = new Y.Doc({ gc: false });
  seed.clientID = 1;
  prosemirrorToYXmlFragment(
    schema.topNodeType.create(
      null,
      blocks.map((b) => (typeof b === "string" ? para(b) : b)),
    ),
    frag(seed),
  );
  const draft = peer(seed, 9);
  const parts: AttributionPart[] = [];
  let base = readBlocks(frag(seed), schema);
  let writers = 100;
  const projection = () => projectReview(diffBlocks(base, readBlocks(frag(draft), schema)));
  const provenance = () => ({ userId: "u1", parts, snapshot: Y.snapshot(draft) });
  const room = {
    draft,
    parts,
    projection,
    ai(run: (d: Y.Doc) => void) {
      const d = peer(draft, 2 + parts.length);
      parts.push({ threadId: `chat${parts.length}`, turnId: "turn", ...ranges(d, () => run(d)) });
      Y.applyUpdate(draft, Y.encodeStateAsUpdate(d));
    },
    writer(run: (d: Y.Doc) => void) {
      const d = peer(draft, writers++, true);
      run(d);
      Y.applyUpdate(draft, Y.encodeStateAsUpdate(d));
    },
    /** Apply: the base takes the draft's text and the server records what moved, as `branch-push` does. */
    apply(record = true) {
      if (record) {
        const classified = classifyChanges(draft, projection(), provenance(), {
          record: true,
        });
        draft.clientID = 1;
        draft.transact(() =>
          appendApplyRecord(draft, applyRecordOf(classified, classified.keys())),
        );
        draft.clientID = 9;
      }
      base = readBlocks(frag(draft), schema);
    },
    /** The writer Discards (`run`) and Undoes it, `rounds` times: Yjs re-creates what the AI wrote. */
    discardUndo(run: (d: Y.Doc) => void, rounds = 1) {
      room.writer((d) => {
        for (let i = 0; i < rounds; i++) {
          const origin = Symbol("discard");
          const history = new Y.UndoManager(frag(d), {
            trackedOrigins: new Set([origin]),
            captureTimeout: 0,
          });
          recordRestorations(history);
          d.transact(() => run(d), origin);
          history.undo();
          history.destroy();
        }
      });
    },
    rebase(live: PMNode[]) {
      const result = rebase(schema, base, live, readBlocks(frag(draft), schema));
      draft.clientID = 1;
      draft.transact(() => writeBlocks(frag(draft), schema, result.blocks));
      draft.clientID = 9;
      base = live;
    },
    /** Names and members per change, on the server's doc and on a gc-on reload; the two must agree. */
    read(options: { budget?: number; slide?: number } = {}) {
      const view = projection();
      const read = (doc: Y.Doc) => {
        const out = classifyChanges(doc, view, provenance(), { ...options, record: true });
        const footprint = (result: ReturnType<typeof classifyChanges>) =>
          [...result.values()].map(({ members, applied }) => ({ members, applied }));
        expect(
          footprint(
            classifyChanges(doc, view, provenance(), { budget: 0, slide: 0, record: true }),
          ),
        ).toEqual(footprint(out));
        const names = (a: Author) => (a.kind === "user" ? "user" : a.threadId);
        return [...out.values()].map((c) => ({ byline: c.byline.map(names), members: c.members }));
      };
      const server = read(draft);
      expect(read(peer(draft, 50, true))).toEqual(server);
      return server;
    },
  };
  return room;
}
type Room = ReturnType<typeof room>;

interface Row {
  name: string;
  run: (r: Room) => void;
  blocks?: Array<string | PMNode>;
  text?: string;
  budget?: number;
  slide?: number;
  /** Per change, in document order, when the row has more than one. */
  groups?: Array<{ byline: string[]; members: number[] }>;
  /** "user" and chat names, in byline order. */
  byline: string[];
  members: number[];
}

const T = (n = 0) => `chat${n}`;
const paragraphXml = (s: string) => {
  const p = new Y.XmlElement("paragraph");
  const t = new Y.XmlText();
  t.insert(0, s);
  p.insert(0, [t]);
  return p;
};
const image = schema.nodes.image.create({ src: "foo.png" });
const withImage = (s: string) => schema.nodes.paragraph.create(null, [image, schema.text(s)]);
const list = schema.nodes.bullet_list.create(null, [
  schema.nodes.list_item.create(null, para("alpha beta gamma delta epsilon")),
]);
const listText = (d: Y.Doc) =>
  (((frag(d).get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(
    0,
  ) as Y.XmlText;
const bold = (s: string) =>
  schema.nodes.paragraph.create(null, schema.text(s, [schema.marks.strong.create()]));
const heading = (level: number, s: string) =>
  schema.nodes.heading.create({ level }, schema.text(s));

const ROWS: Row[] = [
  {
    name: "P1: an AI deletion among repeated words names the chat, stays a member and stays pending",
    text: "echo echo echo tail words",
    run: (r) => r.ai((d) => textOf(d).delete(5, 5)),
    byline: [T()],
    members: [0],
  },
  {
    name: "an insertion before a space the AI wrote",
    text: "alpha beta gamma delta",
    run: (r) => r.ai((d) => textOf(d).insert(5, " MAGIC")),
    byline: [T()],
    members: [0],
  },
  {
    name: "the writer types beside an applied AI space: the writer's, and the part may still be in the change",
    text: "alphabeta gamma delta",
    run: (r) => {
      r.ai((d) => textOf(d).insert(5, " "));
      r.apply(false);
      r.writer((d) => textOf(d).insert(6, "MAGIC "));
    },
    byline: ["user"],
    members: [0],
  },
  {
    name: "the same with the Apply record: the space is the base's, so no chat is in it",
    text: "alphabeta gamma delta",
    run: (r) => {
      r.ai((d) => textOf(d).insert(5, " "));
      r.apply();
      r.writer((d) => textOf(d).insert(6, "MAGIC "));
    },
    byline: ["user"],
    members: [],
  },
  {
    name: "the writer deletes beside an applied AI deletion, without a record: no name, the chat stays in",
    text: "one AIOLD two three four",
    run: (r) => {
      r.ai((d) => textOf(d).delete(4, 6));
      r.apply(false);
      r.writer((d) => textOf(d).delete(4, 4));
    },
    byline: [],
    members: [0],
  },
  {
    name: "the writer deletes beside an applied AI deletion, with the record",
    text: "one AIOLD two three four",
    run: (r) => {
      r.ai((d) => textOf(d).delete(4, 6));
      r.apply();
      r.writer((d) => textOf(d).delete(4, 4));
    },
    byline: ["user"],
    members: [],
  },
  {
    name: "the writer deletes an applied AI word",
    text: "start tail words here",
    run: (r) => {
      r.ai((d) => textOf(d).insert(6, "MAGIC "));
      r.apply();
      r.writer((d) => textOf(d).delete(6, 5));
    },
    byline: ["user"],
    members: [],
  },
  {
    name: "a letter the writer types inside an applied AI word",
    text: "start tail words here",
    run: (r) => {
      r.ai((d) => textOf(d).insert(6, "MAGIC "));
      r.apply();
      r.writer((d) => textOf(d).insert(8, "x"));
    },
    byline: ["user"],
    members: [],
  },
  {
    name: "a block the writer deletes next to an applied AI block deletion, without a record",
    blocks: ["first block gone", "second block gone", "third block stays"],
    run: (r) => {
      r.ai((d) => frag(d).delete(0, 1));
      r.apply(false);
      r.writer((d) => frag(d).delete(0, 1));
    },
    byline: [],
    members: [0],
  },
  {
    name: "the same with the record",
    blocks: ["first block gone", "second block gone", "third block stays"],
    run: (r) => {
      r.ai((d) => frag(d).delete(0, 1));
      r.apply();
      r.writer((d) => frag(d).delete(0, 1));
    },
    byline: ["user"],
    members: [],
  },
  {
    name: "mixed changes: the first chat shares a group with the writer, the second owns another",
    text: "alpha beta gamma delta epsilon zeta",
    run: (r) => {
      r.ai((d) => textOf(d).insert(0, "AI "));
      r.ai((d) => textOf(d).insert(textOf(d).length, " tail"));
      r.writer((d) => textOf(d).insert(textOf(d).toString().indexOf("beta"), "WRITER "));
    },
    byline: ["user", T(0), T(1)],
    members: [0, 1],
    groups: [
      { byline: ["user", T(0)], members: [0] },
      { byline: [T(1)], members: [1] },
    ],
  },
  {
    name: "Discard then Undo of text at the end of a run keeps its chat (no right neighbor to infer from)",
    text: "alpha beta gamma delta",
    run: (r) => {
      r.ai((d) => textOf(d).insert(textOf(d).length, " tail"));
      r.discardUndo((d) => textOf(d).delete(textOf(d).length - 5, 5), 2);
    },
    byline: [T()],
    members: [0],
  },
  ...(
    [
      ["red", "bed"],
      ["young", "younger"],
      ["red", "reed"],
    ] as const
  ).map(
    ([was, now]): Row => ({
      name: `${was} to ${now}, Apply, writer deletion: all raw word items became base`,
      text: `The ${was} gate opens beside the tower.`,
      run: (r) => {
        r.ai((d) =>
          writeBlocks(frag(d), schema, [para(`The ${now} gate opens beside the tower.`)]),
        );
        r.apply();
        r.writer((d) => textOf(d).delete(4, now.length));
      },
      byline: ["user"],
      members: [],
    }),
  ),
  {
    name: "33 Discard and Undo rounds of an insertion still name its chat",
    text: "alpha beta gamma delta",
    run: (r) => {
      r.ai((d) => textOf(d).insert(0, "zeta "));
      r.discardUndo((d) => textOf(d).delete(0, 5), 33);
    },
    byline: [T()],
    members: [0],
  },
  {
    name: "Discard then Undo of a replacement keeps its chat",
    text: "alpha beta gamma delta",
    run: (r) => {
      r.ai((d) => {
        textOf(d).delete(6, 4);
        textOf(d).insert(6, "BETA");
      });
      r.discardUndo((d) => {
        const at = textOf(d).toString().indexOf("BETA");
        textOf(d).delete(at, 4);
        textOf(d).insert(at, "beta");
      });
    },
    byline: [T()],
    members: [0],
  },
  {
    name: "a second Discard and Undo of a deletion",
    text: "alpha beta gamma delta",
    run: (r) => {
      r.ai((d) => textOf(d).delete(6, 5));
      r.discardUndo((d) => textOf(d).insert(6, "beta "), 2);
    },
    byline: [T()],
    members: [0],
  },
  {
    name: "Discard then Undo of a block deletion keeps its chat",
    blocks: ["first block gone", "second block stays", "third block stays"],
    run: (r) => {
      r.ai((d) => frag(d).delete(0, 1));
      r.discardUndo((d) => frag(d).insert(0, [paragraphXml("first block gone")]));
    },
    byline: [T()],
    members: [0],
  },
  {
    name: "the writer types inside a restored AI insertion: both are named, the part stays pending",
    text: "alpha beta gamma",
    run: (r) => {
      r.ai((d) => textOf(d).insert(6, "MAGIC "));
      r.discardUndo((d) => textOf(d).delete(6, 6));
      r.writer((d) => textOf(d).insert(8, "x"));
    },
    byline: ["user", T()],
    members: [0],
  },
  {
    name: "concurrent NEW is named You; the OLD deletion remains a member of the raw replacement",
    text: "alpha OLD tail",
    run: (r) => {
      const stale = peer(r.draft, 600, true);
      textOf(stale).insert(6, "NEW ");
      r.ai((d) => textOf(d).delete(6, 4));
      Y.applyUpdate(r.draft, Y.encodeStateAsUpdate(stale));
    },
    byline: ["user"],
    members: [0],
  },
  {
    name: "a writer replaces a 3-letter AI word with another 3-letter word",
    text: "alpha tail",
    run: (r) => {
      r.ai((d) => textOf(d).insert(6, "OLD"));
      r.writer((d) => {
        textOf(d).delete(6, 3);
        textOf(d).insert(6, "NEW");
      });
    },
    byline: ["user"],
    members: [],
  },
  ...(["insert", "delete"] as const).map(
    (operation): Row => ({
      name: `budget exhausted before an ambiguous ${operation}: footprint keeps both parts`,
      blocks: ["first tail words", "unchanged separator words here", `${"echo ".repeat(250)}tail`],
      budget: 8,
      run: (r) => {
        r.ai((d) => textOf(d).insert(0, "12345678"));
        r.ai((d) =>
          operation === "insert" ? textOf(d, 2).insert(500, "echo ") : textOf(d, 2).delete(500, 5),
        );
      },
      byline: [T()],
      members: [0, 1],
      groups: [
        { byline: [T()], members: [0] },
        { byline: [], members: [1] },
      ],
    }),
  ),
  {
    name: "two chats, each in its own change: neither is credited with the other's",
    text: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu",
    run: (r) => {
      r.ai((d) => textOf(d).insert(0, "ONE "));
      r.ai((d) => textOf(d).insert(textOf(d).length, " TWO"));
    },
    byline: [T(0), T(1)],
    members: [0, 1],
    groups: [
      { byline: [T(0)], members: [0] },
      { byline: [T(1)], members: [1] },
    ],
  },
  {
    name: "Discard then Undo of an AI paragraph keeps its chat",
    text: "alpha tail",
    run: (r) => {
      r.ai((d) => frag(d).insert(0, [paragraphXml("AI new block")]));
      r.discardUndo((d) => frag(d).delete(0, 1), 2);
    },
    byline: [T()],
    members: [0],
  },
  {
    name: "Discard then Undo of AI bold keeps its chat",
    text: "alpha beta gamma delta",
    run: (r) => {
      r.ai((d) => textOf(d).format(6, 4, { strong: true }));
      r.discardUndo((d) => textOf(d).format(6, 4, { strong: null }), 2);
    },
    byline: [T()],
    members: [0],
  },
  {
    name: "Discard then Undo of an AI heading level keeps its chat",
    blocks: [heading(1, "alpha tail")],
    run: (r) => {
      r.ai((d) => (frag(d).get(0) as Y.XmlElement).setAttribute("level", 2 as never));
      r.discardUndo((d) => (frag(d).get(0) as Y.XmlElement).setAttribute("level", 1 as never), 2);
    },
    byline: [T()],
    members: [0],
  },
  {
    name: "an AI that turns a bullet list into a numbered one is still in the change",
    blocks: [list],
    run: (r) =>
      r.ai((d) =>
        writeBlocks(frag(d), schema, [
          schema.nodes.ordered_list.create(null, list.firstChild as PMNode),
        ]),
      ),
    byline: [T()],
    members: [0],
  },
  {
    name: "an AI that removes bold is still in the change",
    blocks: [bold("alpha beta gamma delta")],
    run: (r) => r.ai((d) => textOf(d).format(0, 22, { strong: null })),
    byline: [],
    members: [0],
  },
  {
    name: "an AI insertion into a list, never touched by the writer",
    blocks: [list],
    run: (r) => r.ai((d) => listText(d).insert(0, "AI ")),
    byline: [T()],
    members: [0],
  },
  {
    name: "list type change, Apply, writer deletes a word: rebuilt text became base",
    blocks: [list],
    run: (r) => {
      r.ai((d) =>
        writeBlocks(frag(d), schema, [
          schema.nodes.ordered_list.create(null, list.firstChild as PMNode),
        ]),
      );
      r.apply();
      r.writer((d) => listText(d).delete(6, 4));
    },
    byline: ["user"],
    members: [],
  },
  {
    name: "a heading the AI aligns and the writer re-levels: each owns its own attribute",
    blocks: [heading(1, "Title words here")],
    run: (r) => {
      r.ai((d) => (frag(d).get(0) as Y.XmlElement).setAttribute("align", "center" as never));
      r.apply();
      r.writer((d) => (frag(d).get(0) as Y.XmlElement).setAttribute("level", 2 as never));
    },
    byline: ["user"],
    members: [],
  },
  {
    name: "an AI that only bolds a word",
    text: "alpha beta gamma delta",
    run: (r) => r.ai((d) => textOf(d).format(6, 4, { strong: true })),
    byline: [T()],
    members: [0],
  },
  {
    name: "a rebase that rebuilds a paragraph with an inline image names no one",
    blocks: [withImage("alpha beta gamma delta epsilon")],
    run: (r) => {
      r.ai((d) =>
        writeBlocks(frag(d), schema, [withImage("alpha MAGIC beta gamma delta epsilon")]),
      );
      r.rebase([withImage("alpha beta gamma delta epsilon LIVE")]);
    },
    byline: [],
    members: [],
  },
];

describe("attribution", () => {
  it.each(ROWS)("$name", (row) => {
    const r = room(row.blocks ?? [row.text ?? ""]);
    row.run(r);
    const read = r.read({ budget: row.budget, slide: row.slide });
    expect(read).toEqual(row.groups ?? [{ byline: row.byline, members: row.members }]);
  });

  it("the Apply record holds what the applied change moved into the base, and only that", () => {
    const r = room(["one AIOLD two three four"]);
    r.ai((d) => textOf(d).insert(0, "NEW "));
    r.ai((d) => textOf(d).delete(8, 6));
    const recordOf = (budget?: number) => {
      const classified = classifyChanges(
        r.draft,
        r.projection(),
        { userId: "u", parts: r.parts, snapshot: Y.snapshot(r.draft) },
        { record: true, budget },
      );
      return applyRecordOf(classified, classified.keys());
    };
    const entry = recordOf();
    const [insert, remove] = r.parts;
    expect(entry.base).toEqual(insert.inserted);
    expect(entry.settled).toEqual(remove.deleted);
    // Running out of diff budget silences names; the record Apply persists must not shrink with it.
    expect(recordOf(1)).toEqual(entry);
    r.draft.clientID = 1;
    r.draft.transact(() => appendApplyRecord(r.draft, entry));
    expect(readApplyRecord(r.draft)).toEqual([entry]);
  });
});

it("unlisted item IDs need a covered revision or this browser's client, never absence alone", () => {
  const r = room(["red"]);
  r.ai((doc) => {
    textOf(doc).delete(0, 3);
    textOf(doc).insert(0, "blue");
  });
  const pending = { userId: "u", parts: r.parts, snapshot: Y.snapshot(r.draft) };
  r.writer((doc) => {
    textOf(doc).delete(0, 4);
    textOf(doc).insert(0, "green");
  });
  const read = (snapshot: Y.Snapshot, localClientId?: number) =>
    [
      ...classifyChanges(r.draft, r.projection(), { ...pending, snapshot, localClientId }).values(),
    ][0];
  expect(read(pending.snapshot)).toMatchObject({ byline: [], members: [0], unresolved: true });
  expect(read(Y.snapshot(r.draft))).toMatchObject({
    // The writer replaced blue, but the chat's removal of the base word red still contributes.
    byline: [
      { kind: "user", userId: "u" },
      { kind: "thread", threadId: "chat0", turnId: "turn" },
    ],
    unresolved: false,
  });
  // With no AI writes or deletions in play, this browser can name its own fresh typing.
  const local = room(["base"]);
  textOf(local.draft).insert(0, "writer ");
  expect(
    [
      ...classifyChanges(local.draft, local.projection(), {
        userId: "u",
        parts: [],
        snapshot: Y.emptySnapshot,
        localClientId: local.draft.clientID,
      }).values(),
    ][0].byline,
  ).toEqual([{ kind: "user", userId: "u" }]);
});
