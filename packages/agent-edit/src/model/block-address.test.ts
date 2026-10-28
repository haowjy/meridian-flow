/** The one block address space shared by a live document and its seeded Work draft. */

import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { toDocHandle } from "../handles.js";
import {
  bindBlockOrigins,
  blockHashesForDoc,
  blockItemIdKey,
  fullHashForItemId,
  getBlockItemId,
  lookupBlockHash,
} from "./block-hash.js";
import { PROSEMIRROR_FRAGMENT_NAME } from "./prosemirror-fragment.js";
import { yProsemirrorModel } from "./y-prosemirror.js";

describe("seeded block addresses", () => {
  it("renders and resolves the live identity, then lengthens a colliding prefix on reread", () => {
    const draft = new Y.Doc({ gc: false });
    const fragment = draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    const seeded = new Y.XmlElement("paragraph");
    const local = new Y.XmlElement("paragraph");
    fragment.insert(0, [seeded, local]);

    const localFull = fullHashForItemId(getBlockItemId(local));
    let live = { clientID: 10_000, clock: 0 };
    while (fullHashForItemId(live).slice(0, 4) !== localFull.slice(0, 4)) {
      live = { clientID: live.clientID + 1, clock: 0 };
    }
    bindBlockOrigins(draft, new Map([[blockItemIdKey(getBlockItemId(seeded)), live]]));

    const heldLivePrefix = fullHashForItemId(live).slice(0, 4);
    expect(lookupBlockHash(draft, heldLivePrefix)).toMatchObject({
      ok: false,
      reason: "ambiguous",
    });
    const [seededHash, localHash] = blockHashesForDoc(draft);
    expect(seededHash.length).toBeGreaterThan(4);
    expect(localHash.length).toBeGreaterThan(4);
    expect(lookupBlockHash(draft, seededHash)).toMatchObject({ ok: true, block: seeded });
    expect(lookupBlockHash(draft, localHash)).toMatchObject({ ok: true, block: local });
  });
});

const schema = buildDocumentSchema();

describe("projected block alignment", () => {
  it("keeps every later block under its own hash when y-prosemirror drops an unbuildable block", () => {
    const doc = new Y.Doc({ gc: false });
    const element = (name: string, text: string) => {
      const block = new Y.XmlElement(name);
      const run = new Y.XmlText();
      run.insert(0, text);
      block.insert(0, [run]);
      return block;
    };
    doc
      .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
      .insert(0, [
        element("paragraph", "alpha"),
        element("not_a_node", "junk"),
        element("paragraph", "beta"),
        element("paragraph", "gamma"),
      ]);

    const blocks = yProsemirrorModel(schema).projectBlocks(toDocHandle(doc));

    expect(blocks.map((block) => block.node.textContent)).toEqual(["alpha", "beta", "gamma"]);
    expect(blocks.map((block) => block.hash)).toEqual(blockHashesForDoc(doc));
    expect(blocks.map((block) => block.id)).toEqual(
      doc
        .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
        .toArray()
        .map((block) => getBlockItemId(block as Y.XmlElement)),
    );
  });
});
