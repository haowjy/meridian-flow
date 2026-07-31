// @vitest-environment jsdom
/**
 * A peer mark is a decoration, so the element drawing it is not the mark.
 *
 * Its anchor is a relative position, which is what carries the mark across a
 * remote write. Its element is ProseMirror's to rebuild, and a tick is a keyed
 * widget whose key carries the mark's emphasis and its author's label — so
 * addressing a change from the chat, or a thread title arriving after the turn
 * that made the mark, replaces the element while the mark stays exactly where it
 * is. A surface holding that element measures a detached node from then on,
 * which in a browser is a rect of zeros: the popover parks in the corner of the
 * window with its arm pointing at nothing.
 *
 * Two bindings, because the write that has to be survived is a real one.
 */
import type { ChangeEventWsMessage } from "@meridian/contracts/protocol";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";

import { SessionMarkerStore } from "@/core/editor/session-marker-store";
import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";
import { relativePositionForEditorIndex } from "@/test-support/editor-relative-position";

import { peerMarkElement, peerMarkRect } from "./PeerMarkerExtension";

const CHANGE_ID = "change-1";
/** The geometry jsdom will not supply, so a measurement can be told apart. */
const DRAWN_AT = { x: 40, y: 200, width: 8, height: 18 };

let pair: CollabPair | null = null;

afterEach(() => {
  pair?.destroy();
  pair = null;
  document.body.replaceChildren();
});

function encode(position: Y.RelativePosition): string {
  const bytes = Y.encodeRelativePosition(position);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A collaborator's deletion at `at`, as the wire delivers it. */
function deletionMessage(pairing: CollabPair, at: number): ChangeEventWsMessage {
  const position = relativePositionForEditorIndex(pairing.local, at);
  if (!position) throw new Error("editor binding unavailable");
  return {
    type: "change_event",
    documentId: "doc-1",
    threadId: "thread-1",
    trailId: "trail-1",
    projectionRevision: 1,
    author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
    changes: [
      {
        admittedByUserId: null,
        changeId: CHANGE_ID,
        kind: "delete",
        navigation: {
          kind: "deletion_boundary",
          position: encode(position),
          affinity: "before_next",
        },
        swept: false,
        excerpt: null,
        pureDeletionOffset: null,
      },
    ],
    truncated: false,
  };
}

/** Give the mark's element a box, the way a laid-out page would. */
function drawAt(element: HTMLElement | null): void {
  if (!element) throw new Error("nothing is drawing the mark");
  element.getBoundingClientRect = () => ({ ...DRAWN_AT, toJSON: () => ({}) }) as DOMRect;
}

it("answers where a mark is drawn after the element drawing it has been replaced", async () => {
  const store = new SessionMarkerStore("me");
  pair = createCollabPair(
    {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first" }] },
        { type: "paragraph", content: [{ type: "text", text: "the ledger kept accounts" }] },
      ],
    },
    { markerStore: store },
  );
  const { local, peer, sync } = pair;
  document.body.append(local.view.dom);

  store.replaceGroup(deletionMessage(pair, 12));
  store.reconcileAnchors(() => true);
  // The plugin coalesces its rebuild into a microtask.
  await Promise.resolve();

  const opened = peerMarkElement(local, CHANGE_ID);
  expect(opened?.className).toContain("meridian-peer-mark--tick");

  // A collaborator writes in the same paragraph. The mark moves with its words.
  peer.commands.insertContentAt(8, "PEER ");
  sync();
  await Promise.resolve();
  expect(peerMarkElement(local, CHANGE_ID)?.isConnected).toBe(true);

  // The writer addresses the change from the chat, which rebuilds the tick.
  local.commands.showPeerMarker(CHANGE_ID);
  await Promise.resolve();

  // The hazard: the element a popover opened on is gone, and measuring it is
  // how an anchored surface ends up in the corner of the window.
  expect(opened?.isConnected).toBe(false);
  expect(opened?.getBoundingClientRect()).toMatchObject({ x: 0, y: 0, width: 0, height: 0 });

  const current = peerMarkElement(local, CHANGE_ID);
  expect(current).not.toBe(opened);
  drawAt(current);
  expect(peerMarkRect(local, CHANGE_ID)).toMatchObject(DRAWN_AT);
});

it("answers null once the mark is dismissed, so nothing anchors to it", async () => {
  const store = new SessionMarkerStore("me");
  pair = createCollabPair(
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a line" }] }] },
    { markerStore: store },
  );
  document.body.append(pair.local.view.dom);

  store.replaceGroup(deletionMessage(pair, 3));
  store.reconcileAnchors(() => true);
  await Promise.resolve();
  expect(peerMarkRect(pair.local, CHANGE_ID)).not.toBeNull();

  store.dismiss(CHANGE_ID);
  await Promise.resolve();

  expect(peerMarkRect(pair.local, CHANGE_ID)).toBeNull();
});
