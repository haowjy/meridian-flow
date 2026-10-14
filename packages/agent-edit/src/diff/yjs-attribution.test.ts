/** The attribution hint's named risk: a card naming the wrong chat, or any chat for the writer's own typing. */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { readBlocks } from "./fragments.js";
import { diffBlocks } from "./hunks.js";
import { projectReview } from "./review.js";
import { type AttributionEdit, editsInChanges, matchAttribution } from "./yjs-attribution.js";

const schema = buildDocumentSchema();
const NAME = "prosemirror";

function peer(from: Y.Doc, clientID: number) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
  return doc;
}
const textOf = (doc: Y.Doc, block: number) =>
  (doc.getXmlFragment(NAME).get(block) as Y.XmlElement).get(0) as Y.XmlText;

describe("attribution matching", () => {
  it("names both chats latest first, names a deleting chat, and names nobody for the writer", () => {
    const seed = new Y.Doc();
    seed.clientID = 1;
    const paragraphs = [
      "alpha beta",
      "steady filler words keep these apart",
      "one two three four five six",
      "left alone here today friend",
    ];
    prosemirrorToYXmlFragment(
      schema.topNodeType.create(
        null,
        paragraphs.map((t) => schema.nodes.paragraph.create(null, schema.text(t))),
      ),
      seed.getXmlFragment(NAME),
    );
    const base = readBlocks(seed.getXmlFragment(NAME), schema);
    const clock0 = (block: number) => textOf(seed, block)._start?.id.clock ?? 0;

    const chatA = peer(seed, 2);
    textOf(chatA, 0).insert(textOf(chatA, 0).length, " omega");
    const chatB = peer(seed, 3);
    textOf(chatB, 0).insert(0, "zeta ");
    const chatC = peer(seed, 4);
    textOf(chatC, 2).delete(4, 4); // " two"... deletes four characters
    const writer = peer(seed, 5);
    textOf(writer, 3).insert(0, "WRITER ");

    const merged = peer(seed, 9);
    for (const d of [chatA, chatB, chatC, writer]) Y.applyUpdate(merged, Y.encodeStateAsUpdate(d));
    const draft = readBlocks(merged.getXmlFragment(NAME), schema);
    const projection = projectReview(diffBlocks(base, draft));
    expect(projection.groups).toHaveLength(3);

    const edits: AttributionEdit[] = [
      {
        threadId: "A",
        title: "Chat A",
        turnId: "t1",
        at: "2026-10-13T10:00:00Z",
        inserted: [[2, 0, 6]],
        deleted: [],
      },
      {
        threadId: "B",
        title: "Chat B",
        turnId: "t2",
        at: "2026-10-13T11:00:00Z",
        inserted: [[3, 0, 5]],
        deleted: [],
      },
      {
        threadId: "C",
        title: "Chat C",
        turnId: "t3",
        at: "2026-10-13T09:00:00Z",
        inserted: [],
        deleted: [[1, clock0(2) + 4, 4]],
      },
    ];
    const hints = matchAttribution(merged.getXmlFragment(NAME), projection, edits);
    const byText = (needle: string) => {
      const g = projection.groups.find(
        (x) => x.excerpt.inserted.includes(needle) || x.excerpt.removed.includes(needle),
      );
      if (!g) throw new Error(`no group mentions ${needle}`);
      return g;
    };

    expect(hints.get(byText("omega").id)?.map((h) => h.threadId)).toEqual(["B", "A"]);
    expect(hints.get(byText("two").id)?.map((h) => h.threadId)).toEqual(["C"]);
    expect(hints.has(byText("WRITER").id)).toBe(false);
    // D13: an edit inside no change (already in the base) is applied; one inside a change is pending.
    const inBase: AttributionEdit = { ...edits[0], inserted: [[1, 0, 3]] };
    expect(editsInChanges(merged.getXmlFragment(NAME), projection, [...edits, inBase])).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});
