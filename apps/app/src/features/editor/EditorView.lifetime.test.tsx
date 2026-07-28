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
import { act, StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type {
  DocumentSession,
  DocumentSessionConnectionState,
  DocumentSessionSnapshot,
  SchemaFence,
} from "@/core/editor/document-session";
import type { SchemaRepairEvent } from "@/core/editor/schema-repair-witness";
import { SessionMarkerStore } from "@/core/editor/session-marker-store";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { EditorViewProps } from "./EditorView";

type ThreadListItem = { id: string; title: string | null };

const threadList: { current: ThreadListItem[] } = {
  current: [{ id: "thread-1", title: "Chapter voice" }],
};

const sessions = new Map<string, DocumentSession>();
const sessionSnapshots = new Map<string, DocumentSessionSnapshot>();
const sessionListeners = new Map<string, Set<(snapshot: DocumentSessionSnapshot) => void>>();
const sessionHorizons = new Map<
  string,
  { localPersistence: Promise<void>; firstServerSync: Promise<void> }
>();

function sessionFor(roomKey: string): DocumentSession {
  const existing = sessions.get(roomKey);
  if (existing) return existing;
  const doc = new Y.Doc({ gc: false });
  const awareness = new Awareness(doc);
  const snapshot: DocumentSessionSnapshot = {
    documentId: roomKey,
    roomKey,
    room: { kind: "live", documentId: roomKey },
    status: "detached",
    connectionState: null,
    localPersistenceSynced: true,
    schemaFence: null,
    schemaRepairs: [],
  };
  const listeners = new Set<(next: DocumentSessionSnapshot) => void>();
  sessionSnapshots.set(roomKey, snapshot);
  sessionListeners.set(roomKey, listeners);
  const session = {
    roomKey,
    document: doc,
    awareness,
    cursorProvider: { awareness },
    markerStore: new SessionMarkerStore("writer"),
    whenLocalPersistenceSynced: () =>
      sessionHorizons.get(roomKey)?.localPersistence ?? Promise.resolve(),
    whenSynced: () => sessionHorizons.get(roomKey)?.firstServerSync ?? Promise.resolve(),
    reportSchemaRepair: (event: SchemaRepairEvent) => {
      const current = sessionSnapshots.get(roomKey) ?? snapshot;
      const next = { ...current, schemaRepairs: [...current.schemaRepairs, event] };
      sessionSnapshots.set(roomKey, next);
      for (const listener of listeners) listener(next);
    },
    getSnapshot: () => sessionSnapshots.get(roomKey) ?? snapshot,
    subscribe: (listener: (next: DocumentSessionSnapshot) => void) => {
      listeners.add(listener);
      listener(sessionSnapshots.get(roomKey) ?? snapshot);
      return () => listeners.delete(listener);
    },
  } as unknown as DocumentSession;
  sessions.set(roomKey, session);
  return session;
}

function raiseSchemaFence(roomKey: string, fence: SchemaFence): void {
  const snapshot = sessionSnapshots.get(roomKey);
  if (!snapshot || snapshot.schemaFence) return;
  const fenced = { ...snapshot, schemaFence: fence };
  sessionSnapshots.set(roomKey, fenced);
  for (const listener of sessionListeners.get(roomKey) ?? []) listener(fenced);
}

function setConnectionState(
  roomKey: string,
  connectionState: DocumentSessionConnectionState,
): void {
  const snapshot = sessionSnapshots.get(roomKey);
  if (!snapshot) return;
  const next = { ...snapshot, connectionState };
  sessionSnapshots.set(roomKey, next);
  for (const listener of sessionListeners.get(roomKey) ?? []) listener(next);
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

function Harness({ initial }: { initial: EditorViewProps }) {
  const [props, setProps] = useState(initial);
  applyProps = (next) => setProps((previous) => ({ ...previous, ...next }));
  return <EditorView {...props} />;
}

describe("editor lifetime", () => {
  it("keeps the pending shell until persistence and first server sync both finish", async () => {
    const documentId = "horizon-controlled";
    let resolvePersistence!: () => void;
    let resolveServer!: () => void;
    sessionHorizons.set(documentId, {
      localPersistence: new Promise((resolve) => {
        resolvePersistence = resolve;
      }),
      firstServerSync: new Promise((resolve) => {
        resolveServer = resolve;
      }),
    });

    await withReactRoot(<EditorView documentId={documentId} />, async () => {
      expect(document.querySelector(".ProseMirror")).toBeNull();
      await act(async () => {
        resolvePersistence();
        await Promise.resolve();
      });
      expect(document.querySelector(".ProseMirror")).toBeNull();

      await act(async () => {
        resolveServer();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mountedEditor()).toBeDefined();
    });
  });

  it.each([
    ["live", { documentId: "clean-live", projectId: "project-1" }],
    ["live detached", { documentId: "clean-detached", projectId: "project-1", detached: true }],
    [
      "review room",
      {
        documentId: "clean-review-live",
        projectId: "project-1",
        reviewDraftId: "draft-clean-review",
        reviewRoomName: "branch:clean-review:gen:1",
      },
    ],
  ] as const)("opens valid content with zero repair verdicts in the %s config", async (_name, props) => {
    await withReactRoot(<EditorView {...props} />, async () => {
      expect(mountedEditor()).toBeDefined();
      const roomKey = "reviewRoomName" in props ? props.reviewRoomName : props.documentId;
      expect(sessionSnapshots.get(roomKey)?.schemaRepairs).toEqual([]);
      expect(document.querySelector("[data-schema-repair-notice]")).toBeNull();
    });
  });

  it("double-mounts valid content under StrictMode with zero repair verdicts", async () => {
    const documentId = "clean-strict-mode";
    await withReactRoot(
      <StrictMode>
        <EditorView documentId={documentId} projectId="project-1" />
      </StrictMode>,
      async () => {
        expect(mountedEditor()).toBeDefined();
        expect(sessionSnapshots.get(documentId)?.schemaRepairs).toEqual([]);
      },
    );
  });

  it("survives query churn and live surface changes, and rebuilds only for a new room", async () => {
    const initial = { documentId: "document-1", projectId: "project-1" };
    await withReactRoot(<Harness initial={initial} />, async () => {
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

  it("opens read-only when the surface asks for it — the phone must not mount editable", async () => {
    const initial = { documentId: "document-3", projectId: "project-1", editable: false };
    await withReactRoot(<Harness initial={initial} />, async () => {
      expect(mountedEditor().isEditable).toBe(false);
      expect(mountedEditor().view.dom.getAttribute("contenteditable")).toBe("false");
    });
  });

  it("keeps the editor instance and turns it read-only when its session is fenced", async () => {
    const initial = { documentId: "document-fenced", projectId: "project-1" };
    await withReactRoot(<Harness initial={initial} />, async () => {
      const original = tagOf(mountedEditor(), "editor");
      expect(mountedEditor().isEditable).toBe(true);
      await act(async () => {
        mountedEditor().commands.insertContent("Fenced words");
      });

      await act(async () => {
        raiseSchemaFence("document-fenced", { reason: "client-superseded" });
      });

      expect(tagOf(mountedEditor(), "editor")).toBe(original);
      expect(mountedEditor().isEditable).toBe(false);
      expect(mountedEditor().view.dom.getAttribute("contenteditable")).toBe("false");
      const fencedHtml = mountedEditor().getHTML();
      const toolbarButtons =
        document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button');
      expect(toolbarButtons.length).toBeGreaterThan(0);
      expect([...toolbarButtons].every((button) => button.disabled)).toBe(true);
      await act(async () => {
        document.querySelector<HTMLButtonElement>('button[aria-label="Bold"]')?.click();
      });
      expect(mountedEditor().getHTML()).toBe(fencedHtml);
      expect(document.querySelector("[data-schema-fence]")?.textContent).toBe(
        "This chapter was opened in a newer version of Meridian. Refresh to keep writing.",
      );
    });
  });

  it("replaces a stale-head editor with the unstyled unavailable state", async () => {
    const initial = { documentId: "document-stale", projectId: "project-1" };
    await withReactRoot(<Harness initial={initial} />, async () => {
      expect(mountedEditor()).toBeDefined();

      await act(async () => {
        setConnectionState("document-stale", {
          kind: "reset",
          reason: "document-schema-stale",
          code: 4407,
        });
      });

      const unavailable = document.querySelector("[data-document-schema-stale]");
      expect(unavailable?.textContent).toBe("This chapter is temporarily unavailable");
      expect(unavailable?.hasAttribute("class")).toBe(false);
      expect(document.querySelector(".ProseMirror")).toBeNull();
      expect(sessionSnapshots.get("document-stale")?.schemaFence).toBeNull();
    });
  });
});
