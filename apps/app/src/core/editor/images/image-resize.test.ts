// @vitest-environment jsdom
/**
 * The two halves of a resize: the arithmetic the drag runs on, and the one
 * transaction it ends with.
 */
import type { JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";

import { holdNode } from "../anchors";
import {
  type ImageResizeGesture,
  imageWidthAttr,
  resizedImageWidth,
  setImageWidth,
} from "./image-resize";

let pair: CollabPair | null = null;

afterEach(() => {
  pair?.destroy();
  pair = null;
});

const gesture = (over: Partial<ImageResizeGesture> = {}): ImageResizeGesture => ({
  corner: "bottom-right",
  startWidth: 400,
  ratio: 0.5,
  minimum: 24,
  maximum: 640,
  ...over,
});

describe("resizedImageWidth", () => {
  it("follows the corner outward and inward", () => {
    expect(resizedImageWidth(gesture(), { x: 100, y: 50 })).toBe(500);
    expect(resizedImageWidth(gesture(), { x: -100, y: -50 })).toBe(300);
  });

  it("reads every corner as its own outward direction", () => {
    // Up and to the left: away from the bottom-right corner (which shrinks by
    // the full 100 above), toward the top-left one, and across the other two.
    const upLeft = { x: -100, y: -50 };
    expect(resizedImageWidth(gesture({ corner: "top-left" }), upLeft)).toBe(500);
    expect(resizedImageWidth(gesture({ corner: "top-right" }), upLeft)).toBe(340);
    expect(resizedImageWidth(gesture({ corner: "bottom-left" }), upLeft)).toBe(460);
  });

  // The pointer rarely travels along the picture's diagonal. The offset is
  // projected onto it, so a straight-down drag still grows the picture and a
  // drag across the diagonal splits the difference instead of jumping.
  it("projects an off-diagonal drag rather than reading one axis", () => {
    expect(resizedImageWidth(gesture(), { x: 0, y: 50 })).toBe(420);
    expect(resizedImageWidth(gesture(), { x: 100, y: 0 })).toBe(480);
  });

  it("stops at the column and at one line of prose", () => {
    expect(resizedImageWidth(gesture(), { x: 10_000, y: 5_000 })).toBe(640);
    expect(resizedImageWidth(gesture(), { x: -10_000, y: -5_000 })).toBe(24);
  });
});

const sentenceAround = (attrs: Record<string, unknown>): JSONContent => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "before " },
        { type: "image", attrs },
        { type: "text", text: " after" },
      ],
    },
  ],
});

function imagePos(pair: CollabPair): number {
  let found = -1;
  pair.local.state.doc.descendants((node, pos) => {
    if (node.type.name === "image") found = pos;
    return found === -1;
  });
  if (found === -1) throw new Error("no image in the document");
  return found;
}

describe("setImageWidth", () => {
  it("writes one history event and carries the peer's picture with it", () => {
    pair = createCollabPair(sentenceAround({ src: "asset:a1", alt: "map" }));
    const at = imagePos(pair);
    const hold = holdNode(pair.local.state, at);
    if (!hold) throw new Error("expected a hold on the picture");

    setImageWidth(pair.local, hold, 240);
    pair.sync();

    expect(imageWidthAttr(pair.local.state.doc.nodeAt(at)?.attrs ?? {})).toBe(240);
    expect(imageWidthAttr(pair.peer.state.doc.nodeAt(at)?.attrs ?? {})).toBe(240);
  });

  // A picture still on its way is an ordinary node with an ordinary size. A
  // resize that dropped its token would orphan the bytes in flight and leave a
  // peer drawing "this never finished uploading" over a live upload.
  it("leaves an in-flight slot's upload token alone", () => {
    pair = createCollabPair(
      sentenceAround({ src: "", alt: "cover", uploadToken: "image-upload:7f3a:1" }),
    );
    const at = imagePos(pair);
    const hold = holdNode(pair.local.state, at);
    if (!hold) throw new Error("expected a hold on the slot");

    setImageWidth(pair.local, hold, 320);
    pair.sync();

    expect(pair.local.state.doc.nodeAt(at)?.attrs.uploadToken).toBe("image-upload:7f3a:1");
    expect(pair.peer.state.doc.nodeAt(at)?.attrs.width).toBe(320);
  });

  // What makes the whole drag one undo step: the gesture dispatches nothing
  // until the writer lets go, so the wire and the history hear one event.
  // (That the writer's undo then restores the old size is checked in the
  // browser, where the Yjs undo manager's own grouping is real.)
  it("commits the whole drag as one transaction", () => {
    pair = createCollabPair(sentenceAround({ src: "asset:a1", alt: "map" }));
    const hold = holdNode(pair.local.state, imagePos(pair));
    if (!hold) throw new Error("expected a hold on the picture");

    let dispatched = 0;
    pair.local.on("transaction", () => {
      dispatched += 1;
    });
    setImageWidth(pair.local, hold, 240);
    setImageWidth(pair.local, hold, 240);

    expect(dispatched).toBe(1);
  });

  // The picture the writer grabbed, not the numbers it stood at: a peer's write
  // rebuilds the whole document under the drag, and every position moves.
  it("lands on the held picture after a peer writes above it", () => {
    pair = createCollabPair(sentenceAround({ src: "asset:a1", alt: "map" }));
    const hold = holdNode(pair.local.state, imagePos(pair));
    if (!hold) throw new Error("expected a hold on the picture");

    pair.peer.commands.insertContentAt(0, "<p>a peer's new paragraph</p>");
    pair.sync();

    setImageWidth(pair.local, hold, 180);
    pair.sync();

    expect(imageWidthAttr(pair.local.state.doc.nodeAt(imagePos(pair))?.attrs ?? {})).toBe(180);
  });
});
