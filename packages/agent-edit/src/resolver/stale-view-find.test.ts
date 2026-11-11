/**
 * Guards the invariant "Text converges" (`.context/invariants.md`): a find-based write
 * planned on a stale view lands at its match, whole, after someone deleted text it shares
 * words with. The server plans a reply's write on the model's view and merges the update
 * into the current room, which is what this test does with two Yjs docs.
 */

import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { applyEdits } from "../apply/apply-edits.js";
import { createAgentEditCodecFactory } from "../codec-adapter.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { resolveWrite } from "./resolve.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);
const model = yProsemirrorModel(schema);

it("lands a find write at its match when the stale view's shared words were deleted", () => {
  for (const [write, expected] of [
    [{ command: "insert", content: " DRAFT-B2." }, "A disciple. DRAFT-B2. SIDETEXT"],
    [{ command: "replace", content: "disciple. DRAFT-B2." }, "A disciple. DRAFT-B2. SIDETEXT"],
  ] as const) {
    const room = new Y.Doc({ gc: false });
    room.clientID = 1;
    prosemirrorToYXmlFragment(
      schema.node("doc", null, codec.parse("A disciple. DRAFT-B line. SIDETEXT").blocks),
      room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    );
    const view = new Y.Doc({ gc: false });
    view.clientID = 2;
    Y.applyUpdate(view, Y.encodeStateAsUpdate(room));
    const seen = Y.encodeStateVector(view);

    const resolved = resolveWrite(
      { doc: view, model, codec, links: "preassigned" },
      {
        documentAddress: { documentId: "123e4567-e89b-12d3-a456-426614174000", filePath: "c.md" },
        find: "disciple.",
        ...write,
      },
    );
    if (!resolved.ok) throw new Error(resolved.error.message);
    applyEdits(view, model, resolved.edits, { type: "agent", actorTurnId: "turn-1" });

    const paragraph = room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0) as Y.XmlElement;
    (paragraph.get(0) as Y.XmlText).delete("A disciple.".length, " DRAFT-B line.".length);
    Y.applyUpdate(room, Y.encodeStateAsUpdate(view, seen));

    expect(model.getText(model.getBlocks(room)[0])).toBe(expected);
  }
});
