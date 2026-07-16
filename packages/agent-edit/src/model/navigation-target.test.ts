import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { fullHashForItemId, getBlockItemId } from "./block-hash.js";
import { encodeNavigationPosition, validateLiveBlockRange } from "./navigation-target.js";

function fixture() {
  const doc = new Y.Doc({ gc: false });
  const root = doc.getXmlFragment("prosemirror");
  const first = new Y.XmlElement("paragraph");
  const second = new Y.XmlElement("paragraph");
  root.insert(0, [first, second]);
  const target = {
    kind: "live_block_range" as const,
    relStart: encodeNavigationPosition(Y.createRelativePositionFromTypeIndex(root, 0)),
    relEnd: encodeNavigationPosition(Y.createRelativePositionFromTypeIndex(root, 1)),
    targetBlockId: getBlockItemId(first),
  };
  return { doc, root, first, target };
}

describe("trail navigation target", () => {
  it("validates a server-style item-ID target with the browser-safe predicate", () => {
    const { doc, first, target } = fixture();
    expect(validateLiveBlockRange({ doc, target })?.block).toBe(first);
  });

  it("rejects a deleted target even when its relative positions still resolve", () => {
    const { doc, root, target } = fixture();
    root.delete(0, 1);
    expect(validateLiveBlockRange({ doc, target })).toBeNull();
  });

  it("rejects positions that no longer bracket exactly one top-level block", () => {
    const { doc, root, first, target } = fixture();
    const adjacentViolation = {
      ...target,
      relEnd: encodeNavigationPosition(Y.createRelativePositionFromTypeIndex(root, 2)),
      targetBlockId: getBlockItemId(first),
    };
    expect(validateLiveBlockRange({ doc, target: adjacentViolation })).toBeNull();
  });

  it("keeps validating when a new sibling collides with the recorded display prefix", () => {
    const { doc, root, first, target } = fixture();
    const recordedPrefix = fullHashForItemId(target.targetBlockId).slice(0, 4);
    insertCollidingBlock(doc, root.length, recordedPrefix);

    expect(validateLiveBlockRange({ doc, target })?.block).toBe(first);
  });

  it("rejects an unrelated block that inherits the deleted target's display prefix", () => {
    const { doc, root, target } = fixture();
    const recordedPrefix = fullHashForItemId(target.targetBlockId).slice(0, 4);
    root.delete(0, 1);
    insertCollidingBlock(doc, 0, recordedPrefix);

    expect(validateLiveBlockRange({ doc, target })).toBeNull();
  });
});

function insertCollidingBlock(doc: Y.Doc, index: number, prefix: string): Y.XmlElement {
  for (let clientID = 1; clientID < 2_000_000; clientID += 1) {
    if (fullHashForItemId({ clientID, clock: 0 }).startsWith(prefix)) {
      doc.clientID = clientID;
      const block = new Y.XmlElement("paragraph");
      doc.getXmlFragment("prosemirror").insert(index, [block]);
      return block;
    }
  }
  throw new Error(`Could not find collision for ${prefix}`);
}
