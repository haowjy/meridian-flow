// @vitest-environment jsdom
/** EditorView schema-fence behavior from a live injected session. */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import type { DocumentSession as DocumentSessionType } from "@/core/editor/document-session";

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

    await act(async () => {
      session.raiseSchemaFence({ reason: "repair-detected" });
      await Promise.resolve();
    });

    const preview = document.querySelector("[data-schema-fence-preview]");
    expect(preview?.textContent).toContain("Visible fenced prose");
    expect(preview?.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
  });
});
