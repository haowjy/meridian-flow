import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getBlockHash } from "./block-hash.js";
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
    targetBlockId: getBlockHash(first),
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
      targetBlockId: getBlockHash(first),
    };
    expect(validateLiveBlockRange({ doc, target: adjacentViolation })).toBeNull();
  });
});
