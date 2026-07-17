// @vitest-environment jsdom
/** EditorView schema-fence behavior from a live injected session. */

import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { Editor } from "@tiptap/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type {
  DocumentSessionSnapshot,
  DocumentSession as DocumentSessionType,
} from "@/core/editor/document-session";

const harness = vi.hoisted(() => ({
  session: null as DocumentSessionType | null,
  release: vi.fn(),
  retain: vi.fn(),
}));

vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({
    getRoom: () => harness.session,
    has: () => false,
    release: harness.release,
    retain: harness.retain,
  }),
}));
vi.mock("@/core/editor/live-range-navigation-runtime", () => ({
  registerLiveRangeEditor: () => vi.fn(),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/features/editor/useInlineReviewSync", () => ({
  useInlineReviewSync: () => undefined,
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller: {
      conflictedBlocks: new Set(),
      inlineReviewModelAvailable: vi.fn(),
      registerInlineReviewRuntime: vi.fn(),
      releaseInlineReviewRuntime: vi.fn(),
    },
  }),
}));

const { DocumentSession } = await import("@/core/editor/document-session");
const { EditorView } = await import("./EditorView");

let root: Root | null = null;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  window.cancelAnimationFrame = vi.fn();
  harness.release.mockClear();
  harness.retain.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  await harness.session?.destroy();
  harness.session = null;
  vi.restoreAllMocks();
});

describe("EditorView schema fence", () => {
  it("reactively retires the editable binding and renders the read-only preview", async () => {
    const session = new DocumentSession({
      roomKey: "document-fenced-view",
      enableIndexedDb: false,
    });
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    session.document.transact(() => {
      session.document.getXmlFragment(session.fragmentName).insert(0, [paragraph]);
      paragraph.insert(0, [text]);
      text.insert(0, "Visible fenced prose");
    });
    harness.session = session;
    const container = document.getElementById("root");
    if (!container) throw new Error("missing root");
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <EditorView
          documentId="document-fenced-view"
          editable
          showToolbar={false}
          showCollaborationDecorations={false}
        />,
      );
      await Promise.resolve();
    });
    expect(document.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("true");
    const setEditable = vi.spyOn(Editor.prototype, "setEditable");
    const destroy = vi.spyOn(Editor.prototype, "destroy");

    await act(async () => {
      session.raiseSchemaFence({ reason: "repair-detected" });
      await Promise.resolve();
    });

    const preview = document.querySelector("[data-schema-fence-preview]");
    expect(preview?.textContent).toContain("Visible fenced prose");
    expect(preview?.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
    expect(setEditable).toHaveBeenCalledWith(false);
    const readOnlyOrder = setEditable.mock.invocationCallOrder.at(-1);
    const destroyOrder = destroy.mock.invocationCallOrder[0];
    if (readOnlyOrder === undefined || destroyOrder === undefined) {
      throw new Error("missing editor retirement calls");
    }
    expect(readOnlyOrder).toBeLessThan(destroyOrder);
  });

  it("waits for local persistence replay before cloning a quarantined preview", async () => {
    const ydoc = createCollabYDoc();
    let snapshot: DocumentSessionSnapshot = {
      documentId: "document-quarantined-preview",
      roomKey: "document-quarantined-preview",
      room: { kind: "live", documentId: "document-quarantined-preview" },
      status: "detached",
      connectionState: null,
      localPersistenceSynced: false,
      safetyNotice: null,
      schemaFence: { reason: "repair-detected" },
    };
    const listeners = new Set<(value: DocumentSessionSnapshot) => void>();
    const session = {
      document: ydoc,
      roomKey: snapshot.roomKey,
      getSnapshot: () => snapshot,
      subscribe: (listener: (value: DocumentSessionSnapshot) => void) => {
        listeners.add(listener);
        listener(snapshot);
        return () => listeners.delete(listener);
      },
      destroy: () => ydoc.destroy(),
    } as unknown as DocumentSessionType;
    harness.session = session;
    const container = document.getElementById("root");
    if (!container) throw new Error("missing root");
    root = createRoot(container);

    await act(async () => {
      root?.render(<EditorView documentId="document-quarantined-preview" showToolbar={false} />);
      await Promise.resolve();
    });
    expect(document.querySelector("[data-schema-fence-preview]")).toBeNull();

    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    ydoc.transact(() => {
      ydoc.getXmlFragment("prosemirror").insert(0, [paragraph]);
      paragraph.insert(0, [text]);
      text.insert(0, "Replayed manuscript prose");
    });
    snapshot = { ...snapshot, localPersistenceSynced: true };
    await act(async () => {
      for (const listener of listeners) listener(snapshot);
      await Promise.resolve();
    });

    expect(document.querySelector("[data-schema-fence-preview]")?.textContent).toContain(
      "Replayed manuscript prose",
    );
  });

  it("replaces a stale-head editor with the honest unavailable surface", async () => {
    const ydoc = createCollabYDoc();
    const snapshot: DocumentSessionSnapshot = {
      documentId: "document-stale-head",
      roomKey: "document-stale-head",
      room: { kind: "live", documentId: "document-stale-head" },
      status: "access-lost",
      connectionState: { kind: "reset", reason: "document-schema-stale", code: 4407 },
      localPersistenceSynced: true,
      safetyNotice: null,
      schemaFence: null,
    };
    harness.session = {
      document: ydoc,
      roomKey: snapshot.roomKey,
      getSnapshot: () => snapshot,
      subscribe: (listener: (value: DocumentSessionSnapshot) => void) => {
        listener(snapshot);
        return vi.fn();
      },
      destroy: () => ydoc.destroy(),
    } as unknown as DocumentSessionType;
    const container = document.getElementById("root");
    if (!container) throw new Error("missing root");
    root = createRoot(container);

    await act(async () => {
      root?.render(<EditorView documentId="document-stale-head" />);
      await Promise.resolve();
    });

    expect(document.querySelector("[data-document-schema-stale]")?.textContent).toBe(
      "This chapter is temporarily unavailable",
    );
    expect(document.querySelector(".ProseMirror")).toBeNull();
    expect(document.body.textContent).not.toContain("Syncing");
  });
});
