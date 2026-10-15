/**
 * The attribution classifier's named risks, one table: a writer-only change credited to a chat, a chat
 * named for text it did not write, a chat dropped from a change it did write, and an AI part read as
 * applied while a change still holds it. Every row asserts all three outputs: byline, members, status.
 * Each row also runs on a gc-on reload of the draft that has only the payload's restoration links, and
 * must give the same answer.
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
import { restorationLinks } from "./restorations.js";
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
  const provenance = () => ({
    userId: "u1",
    parts,
    restorations: restorationLinks(draft),
  });
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
    read(options: { budget?: number } = {}) {
      const view = projection();
      const read = (doc: Y.Doc) => {
        const out = classifyChanges(doc, view, provenance(), options);
        const names = (a: Author) => (a.kind === "user" ? "user" : a.threadId);
        return [...out.values()].map((c) => ({ byline: c.byline.map(names), members: c.members }));
      };
      const server = read(draft);
      expect(read(peer(draft, 50, true))).toEqual(server);
      return {
        byline: [...new Set(server.flatMap((c) => c.byline))],
        members: [...new Set(server.flatMap((c) => c.members))].sort(),
        status: parts.map((_, i) =>
          server.some((c) => c.members.includes(i)) ? "pending" : "applied",
        ),
      };
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
  /** "user" and chat names, in byline order. */
  byline: string[];
  members: number[];
  status: Array<"pending" | "applied">;
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
const heading = (level: number, s: string) =>
  schema.nodes.heading.create({ level }, schema.text(s));

const ROWS: Row[] = [
  {
    name: "P1: an AI deletion among repeated words names the chat, stays a member and stays pending",
    text: "echo echo echo tail words",
    run: (r) => r.ai((d) => textOf(d).delete(5, 5)),
    byline: [T()],
    members: [0],
    status: ["pending"],
  },
  {
    name: "an AI insertion among repeated words",
    text: "echo echo tail words",
    run: (r) => r.ai((d) => textOf(d).insert(5, "echo ")),
    byline: [T()],
    members: [0],
    status: ["pending"],
  },
  {
    name: "an insertion before a space the AI wrote",
    text: "alpha beta gamma delta",
    run: (r) => r.ai((d) => textOf(d).insert(5, " MAGIC")),
    byline: [T()],
    members: [0],
    status: ["pending"],
  },
  {
    name: "an insertion after a space the AI wrote",
    text: "alpha beta gamma delta",
    run: (r) => r.ai((d) => textOf(d).insert(6, "MAGIC ")),
    byline: [T()],
    members: [0],
    status: ["pending"],
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
    status: ["pending"],
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
    status: ["applied"],
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
    status: ["pending"],
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
    status: ["applied"],
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
    status: ["applied"],
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
    status: ["applied"],
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
    status: ["pending"],
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
    status: ["applied"],
  },
  {
    name: "a mixed change: two chats and the writer, each named once",
    text: "alpha beta gamma delta epsilon zeta",
    run: (r) => {
      r.ai((d) => textOf(d).insert(0, "AI "));
      r.ai((d) => textOf(d).insert(textOf(d).length, " tail"));
      r.writer((d) => textOf(d).insert(textOf(d).toString().indexOf("beta"), "WRITER "));
    },
    byline: ["user", T(0), T(1)],
    members: [0, 1],
    status: ["pending", "pending"],
  },
  {
    name: "Discard then Undo of an insertion keeps its chat",
    text: "alpha beta gamma delta",
    run: (r) => {
      r.ai((d) => textOf(d).insert(0, "zeta "));
      r.discardUndo((d) => textOf(d).delete(0, 5));
    },
    byline: [T()],
    members: [0],
    status: ["pending"],
  },
  {
    name: "a second Discard and Undo of an insertion",
    text: "alpha beta gamma delta",
    run: (r) => {
      r.ai((d) => textOf(d).insert(0, "zeta "));
      r.discardUndo((d) => textOf(d).delete(0, 5), 2);
    },
    byline: [T()],
    members: [0],
    status: ["pending"],
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
    status: ["pending"],
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
    status: ["pending"],
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
    status: ["pending"],
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
    status: ["pending"],
  },
  {
    name: "NEW typed beside an OLD the AI deleted is the writer's, never the AI's (the probe's accepted reading)",
    text: "alpha OLD tail",
    run: (r) => {
      const stale = peer(r.draft, 600, true);
      textOf(stale).insert(6, "NEW ");
      r.ai((d) => textOf(d).delete(6, 4));
      Y.applyUpdate(r.draft, Y.encodeStateAsUpdate(stale));
    },
    byline: ["user"],
    members: [],
    status: ["applied"],
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
    status: ["applied"],
  },
  {
    name: "a past-budget span names no one and keeps its members",
    text: "alpha beta gamma delta",
    budget: 1,
    run: (r) => r.ai((d) => textOf(d).insert(6, "MAGIC ")),
    byline: [],
    members: [0],
    status: ["pending"],
  },
  {
    name: "an AI insertion into a list, never touched by the writer",
    blocks: [list],
    run: (r) => r.ai((d) => listText(d).insert(0, "AI ")),
    byline: [T()],
    members: [0],
    status: ["pending"],
  },
  {
    name: "a list the writer appends to after Apply",
    blocks: [list],
    run: (r) => {
      r.ai((d) => listText(d).insert(0, "AI "));
      r.apply();
      r.writer((d) => listText(d).insert(listText(d).length, " WRITER"));
    },
    byline: ["user"],
    members: [],
    status: ["applied"],
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
    status: ["applied"],
  },
  {
    name: "an AI that only bolds a word",
    text: "alpha beta gamma delta",
    run: (r) => r.ai((d) => textOf(d).format(6, 4, { strong: true })),
    byline: [T()],
    members: [0],
    status: ["pending"],
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
    status: ["applied"],
  },
];

describe("attribution", () => {
  it.each(ROWS)("$name", (row) => {
    const r = room(row.blocks ?? [row.text ?? ""]);
    row.run(r);
    expect(r.read({ budget: row.budget })).toEqual({
      byline: row.byline,
      members: row.members,
      status: row.status,
    });
  });

  it("the Apply record holds what the applied change moved into the base, and only that", () => {
    const r = room(["one AIOLD two three four"]);
    r.ai((d) => textOf(d).insert(0, "NEW "));
    r.ai((d) => textOf(d).delete(8, 6));
    const classified = classifyChanges(
      r.draft,
      r.projection(),
      { userId: "u", parts: r.parts },
      { record: true },
    );
    r.draft.clientID = 1;
    r.draft.transact(() =>
      appendApplyRecord(r.draft, applyRecordOf(classified, classified.keys())),
    );
    const [entry] = readApplyRecord(r.draft);
    const [insert, remove] = r.parts;
    expect(entry.base).toEqual(insert.inserted);
    expect(entry.settled).toEqual(remove.deleted);
  });
});
