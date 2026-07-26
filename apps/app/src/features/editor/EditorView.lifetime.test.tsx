// @vitest-environment jsdom
/**
 * Editor lifetime contract: only a change to the editor's mount identity may
 * rebuild it. A rebuild destroys the Yjs UndoManager and drops keystrokes in
 * flight, so query churn (a thread-list refetch) and live surface config
 * (editability, accessible label, toolbar chrome) must reach the running
 * instance instead of replacing it.
 *
 * Instances are compared through printable tags: a failed `toBe` on an Editor
 * makes the reporter walk the ProseMirror view into jsdom internals.
 */
import type { Editor } from "@tiptap/core";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type { DocumentSession } from "@/core/editor/document-session";
import { SessionMarkerStore } from "@/core/editor/session-marker-store";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { EditorViewProps } from "./EditorView";

type ThreadListItem = { id: string; title: string | null };

const threadList: { current: ThreadListItem[] } = {
  current: [{ id: "thread-1", title: "Chapter voice" }],
};

const sessions = new Map<string, DocumentSession>();

function sessionFor(roomKey: string): DocumentSession {
  const existing = sessions.get(roomKey);
  if (existing) return existing;
  const doc = new Y.Doc({ gc: false });
  const awareness = new Awareness(doc);
  const session = {
    roomKey,
    document: doc,
    awareness,
    cursorProvider: { awareness },
    markerStore: new SessionMarkerStore("writer"),
    subscribe: () => () => {},
  } as unknown as DocumentSession;
  sessions.set(roomKey, session);
  return session;
}

const registry = {
  retain: () => {},
  release: () => {},
  getRoom: sessionFor,
  getDetached: sessionFor,
  has: () => false,
  get: sessionFor,
};

const controller = {
  registerInlineReviewRuntime: () => {},
  releaseInlineReviewRuntime: () => {},
  inlineReviewModelAvailable: () => {},
};

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: threadList.current, isError: false, isFetching: false }),
}));
vi.mock("@/features/change-trail/trail-detail-query", () => ({
  usePrefetchTrailDetails: () => {},
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({ controller }),
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => registry,
}));
vi.mock("./useInlineReviewSync", () => ({ useInlineReviewSync: () => {} }));
vi.mock("./EditorToolbar", () => ({ EditorToolbar: () => null }));
vi.mock("./SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("./PeerMarkPopover", () => ({ PeerMarkPopover: () => null }));

const { EditorView } = await import("./EditorView");

const instanceTags = new WeakMap<object, string>();
let instanceSequence = 0;

function tagOf(instance: object, prefix: string): string {
  const existing = instanceTags.get(instance);
  if (existing) return existing;
  const tag = `${prefix}-${++instanceSequence}`;
  instanceTags.set(instance, tag);
  return tag;
}

/** The mounted instance, read the way the browser probe reads it. */
function mountedEditor(): Editor {
  const dom = document.querySelector<HTMLElement & { editor?: Editor }>(".ProseMirror");
  if (!dom?.editor) throw new Error("no mounted editor");
  return dom.editor;
}

type UndoManager = { undoStack: unknown[] };

/** Collaborative history is plugin state, so find it the way the probe does. */
function undoManager(editor: Editor): UndoManager {
  for (const plugin of editor.state.plugins) {
    const state: unknown = plugin.getState(editor.state);
    if (state && typeof state === "object" && "undoManager" in state) {
      return (state as { undoManager: UndoManager }).undoManager;
    }
  }
  throw new Error("no collaborative undo manager");
}

let applyProps: (next: Partial<EditorViewProps>) => void = () => {};

function Harness() {
  const [props, setProps] = useState<EditorViewProps>({
    documentId: "document-1",
    projectId: "project-1",
  });
  applyProps = (next) => setProps((previous) => ({ ...previous, ...next }));
  return <EditorView {...props} />;
}

describe("editor lifetime", () => {
  it("survives query churn and live surface changes, and rebuilds only for a new room", async () => {
    await withReactRoot(<Harness />, async () => {
      const original = tagOf(mountedEditor(), "editor");
      const history = undoManager(mountedEditor());
      await act(async () => {
        mountedEditor().commands.insertContent("words the writer typed");
      });
      const undoDepth = history.undoStack.length;
      const historyTag = tagOf(history, "undo-manager");
      expect(undoDepth).toBeGreaterThan(0);

      // A thread-list refetch hands the tree a brand-new array on every turn.
      await act(async () => {
        threadList.current = [{ id: "thread-1", title: "Chapter voice — revised" }];
        applyProps({});
      });
      expect(tagOf(mountedEditor(), "editor")).toBe(original);
      expect(tagOf(undoManager(mountedEditor()), "undo-manager")).toBe(historyTag);

      // Live surface config: editability and chrome apply to the same instance.
      await act(async () => {
        applyProps({ editable: false, ariaLabel: "Read-only live document", showToolbar: false });
      });
      const afterSurfaceChange = mountedEditor();
      expect(tagOf(afterSurfaceChange, "editor")).toBe(original);
      expect(tagOf(undoManager(afterSurfaceChange), "undo-manager")).toBe(historyTag);
      expect(history.undoStack.length).toBe(undoDepth);
      expect(afterSurfaceChange.isEditable).toBe(false);
      expect(afterSurfaceChange.view.dom.getAttribute("aria-label")).toBe(
        "Read-only live document",
      );

      // Room identity is the one thing that may replace the editor.
      await act(async () => {
        applyProps({ documentId: "document-2" });
      });
      expect(tagOf(mountedEditor(), "editor")).not.toBe(original);
    });
  });
});
