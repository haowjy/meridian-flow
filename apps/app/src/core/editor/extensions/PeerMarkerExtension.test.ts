// @vitest-environment jsdom
import type { ChangeEventWsMessage } from "@meridian/contracts/protocol";
import { Editor } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig } from "../config";
import { SessionMarkerStore } from "../session-marker-store";
import { relativePositionForEditorIndex } from "./LiveRangeNavigationExtension";

let editor: Editor;
let store: SessionMarkerStore;

function encode(position: Y.RelativePosition): string {
  const bytes = Y.encodeRelativePosition(position);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function addMarker(
  kind: "range" | "boundary",
  from: number,
  to = from,
  suffix = "",
  pureDeletionOffset: number | null = null,
): void {
  const start = relativePositionForEditorIndex(editor, from);
  const end = relativePositionForEditorIndex(editor, to);
  if (!start || !end) throw new Error("editor binding unavailable");
  const navigation =
    kind === "range"
      ? {
          kind: "live_block_range" as const,
          relStart: encode(start),
          relEnd: encode(end),
          targetBlockId: { clientID: 1, clock: 0 },
        }
      : {
          kind: "deletion_boundary" as const,
          position: encode(start),
          affinity: "before_next" as const,
        };
  const message: ChangeEventWsMessage = {
    type: "change_event",
    documentId: "doc-1",
    threadId: "thread-1",
    trailId: `trail-${kind}${suffix}`,
    projectionRevision: 1,
    author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
    admittedByUserId: null,
    changes: [
      {
        changeId: `${kind}-mark${suffix}`,
        kind: kind === "range" ? "modify" : "delete",
        navigation,
        swept: false,
        excerpt: null,
        pureDeletionOffset,
      },
    ],
    truncated: false,
  };
  store.replaceGroup(message);
  store.reconcileAnchors(() => true);
}

function dismissed(id: string): boolean {
  return store.getSnapshot().find((marker) => marker.changeId === id)?.dismissed ?? false;
}

beforeEach(() => {
  const doc = new Y.Doc({ gc: false });
  store = new SessionMarkerStore("me");
  editor = new Editor({
    element: document.createElement("div"),
    ...createEditorConfig({
      document: doc,
      awareness: new Awareness(doc),
      markerStore: store,
    }),
  });
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
  });
});

afterEach(() => editor.destroy());

describe("peer marker writer self-clear", () => {
  it("clears a range for an interior insertion but not insertion at its start boundary", () => {
    addMarker("range", 2, 5);
    editor.commands.insertContentAt(2, "x");
    expect(dismissed("range-mark")).toBe(false);
    editor.commands.insertContentAt(4, "x");
    expect(dismissed("range-mark")).toBe(true);
  });

  it("does not clear a range for insertion at its end boundary", () => {
    addMarker("range", 2, 5);
    editor.commands.insertContentAt(5, "x");
    expect(dismissed("range-mark")).toBe(false);
  });

  it("clears a range for an overlapping deletion but not caret movement", () => {
    addMarker("range", 2, 5);
    editor.commands.setTextSelection(3);
    expect(dismissed("range-mark")).toBe(false);
    editor.commands.deleteRange({ from: 4, to: 6 });
    expect(dismissed("range-mark")).toBe(true);
  });

  it("clears a boundary for insertion at the seam and deletion covering it", () => {
    addMarker("boundary", 3);
    editor.commands.insertContentAt(3, "x");
    expect(dismissed("boundary-mark")).toBe(true);

    addMarker("boundary", 4, 4, "-delete");
    editor.commands.deleteRange({ from: 2, to: 5 });
    expect(dismissed("boundary-mark-delete")).toBe(true);
  });

  it("does not clear for a remote y-sync transaction", () => {
    addMarker("range", 2, 5);
    const tr = editor.state.tr.insertText("x", 3).setMeta(ySyncPluginKey, {
      isChangeOrigin: true,
    });
    editor.view.dispatch(tr);
    expect(dismissed("range-mark")).toBe(false);
  });

  it("clears a pure-deletion tick only at its effective position", () => {
    addMarker("range", 1, 6, "-before", 2);
    editor.commands.insertContentAt(2, "x");
    expect(dismissed("range-mark-before")).toBe(false);

    addMarker("range", 1, 7, "-at", 2);
    editor.commands.insertContentAt(3, "x");
    expect(dismissed("range-mark-at")).toBe(true);

    addMarker("range", 1, 8, "-after", 2);
    editor.commands.insertContentAt(6, "x");
    expect(dismissed("range-mark-after")).toBe(false);
  });

  it("projects range and boundary markers with their final forms", () => {
    addMarker("range", 2, 5);
    addMarker("boundary", 6);
    editor.view.dispatch(editor.state.tr.setMeta("peer-markers:rebuild", true));
    expect(editor.view.dom.querySelector(".meridian-peer-mark--range")?.textContent).toBe("ell");
    expect(editor.view.dom.querySelector(".meridian-peer-mark--seam")).not.toBeNull();
  });

  it("projects a pure deletion as an inline tick instead of a range", () => {
    addMarker("range", 1, 6, "-deletion", 2);
    editor.view.dispatch(editor.state.tr.setMeta("peer-markers:rebuild", true));
    expect(editor.view.dom.querySelector(".meridian-peer-mark--tick")).not.toBeNull();
    expect(editor.view.dom.querySelector(".meridian-peer-mark--range")).toBeNull();
  });
});
