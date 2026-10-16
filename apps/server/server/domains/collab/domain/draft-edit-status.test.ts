/** An AI edit reads pending while any review change holds it, even where its place in the text is ambiguous. */
import { REVIEW_BASE_FRAGMENT } from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { partsInChanges } from "./draft-edit-status.js";

const schema = buildDocumentSchema();

describe("partsInChanges", () => {
  it("keeps an AI deletion in the middle of a long repeat pending", () => {
    const text = `${"echo ".repeat(250)}tail words`;
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 1;
    const paragraph = schema.nodes.paragraph.create(null, schema.text(text));
    const top = schema.topNodeType.create(null, [paragraph]);
    prosemirrorToYXmlFragment(top, doc.getXmlFragment(REVIEW_BASE_FRAGMENT));
    prosemirrorToYXmlFragment(top, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
    const ai = new Y.Doc({ gc: false });
    ai.clientID = 2;
    Y.applyUpdate(ai, Y.encodeStateAsUpdate(doc));
    const deleted: Array<{ client: number; clock: number; len: number }> = [];
    ai.on("afterTransaction", (tr: Y.Transaction) => {
      for (const [client, items] of tr.deleteSet.clients)
        for (const d of items) deleted.push({ client, clock: d.clock, len: d.len });
    });
    const body = (ai.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0) as Y.XmlElement).get(
      0,
    ) as Y.XmlText;
    body.delete(500, 5);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(ai));
    expect(partsInChanges(doc, [{ effect: { inserted: [], deleted } }])).toEqual([true]);
  });
});
