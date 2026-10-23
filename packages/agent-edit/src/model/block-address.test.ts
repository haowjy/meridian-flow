/** The one block address space shared by a live document and its seeded Work draft. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  bindBlockOrigins,
  blockHashesForDoc,
  blockItemIdKey,
  fullHashForItemId,
  getBlockItemId,
  lookupBlockHash,
} from "./block-hash.js";
import { PROSEMIRROR_FRAGMENT_NAME } from "./prosemirror-fragment.js";

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
