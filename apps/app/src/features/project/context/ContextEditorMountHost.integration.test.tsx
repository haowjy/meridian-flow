/**
 * @vitest-environment jsdom
 *
 * Integration tests for document editor session lifecycle through the shared
 * `DocumentSessionRegistry`.
 *
 * The production path is split: editor views bind to an existing session with
 * `registry.get(documentId)`, while the desktop tab host retains/releases the
 * true open-document set. These tests use a fake
 * registry that throws on duplicate subscribe and records unsubscribe events,
 * mirroring the multiplexed Yjs transport invariant without loading TipTap/Yjs.
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fakeRegistry, resetFakeRegistry, subscribed, events } = vi.hoisted(() => {
  type Event = { type: "subscribe" | "unsubscribe"; documentId: string };

  const subscribed = new Set<string>();
  const sessions = new Set<string>();
  const ownerSets = new Map<string, Set<string>>();
  const events: Event[] = [];

  function fakeSubscribe(documentId: string): void {
    if (subscribed.has(documentId)) {
      throw new Error(`fake-transport: already subscribed to ${documentId}`);
    }
    subscribed.add(documentId);
    sessions.add(documentId);
    events.push({ type: "subscribe", documentId });
  }

  function fakeUnsubscribe(documentId: string): void {
    if (!subscribed.has(documentId)) return;
    subscribed.delete(documentId);
    sessions.delete(documentId);
    events.push({ type: "unsubscribe", documentId });
  }

  function retainedUnion(): Set<string> {
    const keep = new Set<string>();
    for (const ids of ownerSets.values()) {
      for (const id of ids) keep.add(id);
    }
    return keep;
  }

  function reconcile(): void {
    const keep = retainedUnion();
    for (const id of keep) {
      if (!sessions.has(id)) fakeSubscribe(id);
    }
    for (const id of Array.from(sessions)) {
      if (!keep.has(id)) fakeUnsubscribe(id);
    }
  }

  const fakeRegistry = {
    get(documentId: string) {
      if (!sessions.has(documentId)) fakeSubscribe(documentId);
      return { documentId };
    },
    retain(ownerId: string, documentIds: Iterable<string>) {
      ownerSets.set(ownerId, new Set(documentIds));
      reconcile();
    },
    release(ownerId: string) {
      ownerSets.delete(ownerId);
      reconcile();
    },
    destroyAll() {
      ownerSets.clear();
      for (const id of Array.from(sessions)) fakeUnsubscribe(id);
    },
  };

  function resetFakeRegistry(): void {
    ownerSets.clear();
    sessions.clear();
    subscribed.clear();
    events.length = 0;
  }

  return { fakeRegistry, resetFakeRegistry, subscribed, events };
});

vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => fakeRegistry,
}));

// Stub editor: bind to the registry on mount and intentionally do NOT destroy
// on unmount. Production `EditorView` follows this same ownership split: views
// consume sessions; registry retain/release owns transport teardown.
function EditorStub({ documentId }: { documentId: string }) {
  useEffect(() => {
    fakeRegistry.get(documentId);
  }, [documentId]);
  return <div data-document-id={documentId} />;
}

vi.mock("@/features/editor/EditorView", () => ({
  EditorView: ({ documentId }: { documentId: string }) => <EditorStub documentId={documentId} />,
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => <>{children}</>,
}));

vi.mock("./ContextDocumentBreadcrumb", () => ({
  ContextDocumentBreadcrumb: () => null,
}));

vi.mock("./ContextViewerHost", () => ({
  ContextViewerHost: () => <div data-context-viewer-host />,
}));

import { ContextEditorMountHost, MAX_MOUNTED_EDITORS } from "./ContextEditorMountHost";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const OWNER = "test-context-editor-mount-host";

function makeTabs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    documentId: `doc-${i}`,
    scheme: "kb" as const,
    path: `/notes/doc-${i}.md`,
    name: `doc-${i}.md`,
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
  }));
}

describe("ContextEditorMountHost (registry lifecycle integration)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetFakeRegistry();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    fakeRegistry.destroyAll();
    container.remove();
  });

  it("reconciles desktop open tabs through the registry without duplicate subscriptions", () => {
    const tabs = makeTabs(MAX_MOUNTED_EDITORS + 2);

    function render(openCount: number, activeIndex: number) {
      const trackedTabs = tabs.slice(0, openCount);
      act(() => {
        root.render(
          <ContextEditorMountHost
            projectId={PROJECT}
            trackedTabs={trackedTabs}
            activeTabId={trackedTabs[activeIndex]?.documentId ?? null}
            registryOwner={OWNER}
          />,
        );
      });
    }

    for (let i = 0; i < tabs.length; i++) {
      render(i + 1, i);
      expect([...subscribed].sort()).toEqual(
        tabs
          .slice(0, i + 1)
          .map((tab) => tab.documentId)
          .sort(),
      );
    }

    const closedDoc = tabs[1]?.documentId;
    if (!closedDoc) throw new Error("missing test tab");
    act(() => {
      root.render(
        <ContextEditorMountHost
          projectId={PROJECT}
          trackedTabs={tabs.filter((tab) => tab.documentId !== closedDoc)}
          activeTabId={tabs[0]?.documentId ?? null}
          registryOwner={OWNER}
        />,
      );
    });

    expect(subscribed.has(closedDoc)).toBe(false);
    expect(events).toContainEqual({ type: "unsubscribe", documentId: closedDoc });

    act(() => {
      root.render(
        <ContextEditorMountHost
          projectId={PROJECT}
          trackedTabs={tabs}
          activeTabId={closedDoc}
          registryOwner={OWNER}
        />,
      );
    });

    expect(subscribed.has(closedDoc)).toBe(true);
    expect(
      events.filter((event) => event.type === "subscribe" && event.documentId === closedDoc),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "unsubscribe" && event.documentId === closedDoc),
    ).toHaveLength(1);
  });

  it("tearing down the desktop host fully drains every retained subscription", () => {
    const tabs = makeTabs(MAX_MOUNTED_EDITORS);

    act(() => {
      root.render(
        <ContextEditorMountHost
          projectId={PROJECT}
          trackedTabs={tabs}
          activeTabId={tabs[0]?.documentId ?? null}
          registryOwner={OWNER}
        />,
      );
    });

    expect(subscribed.size).toBe(tabs.length);

    act(() => {
      root.unmount();
    });

    expect(subscribed.size).toBe(0);
  });
});
