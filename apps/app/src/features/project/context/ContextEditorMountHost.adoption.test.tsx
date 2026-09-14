// @vitest-environment jsdom
/** Local publication changes document metadata, not the mounted editor or its selection. */
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextEditorMountHost } from "./ContextEditorMountHost";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";

const local = vi.hoisted(() => {
  const session = { suspendPresence() {}, resumePresence() {} };
  return {
    session,
    resources: {
      openDocument: vi.fn(async () => ({
        kind: "opened",
        handle: { documentId: "document", session, release() {} },
      })),
      keyForDocument: async () => null,
      captureServerSession: async () => undefined,
    },
  };
});
vi.mock("./account-feature-context", () => ({
  useAccountResourceReplica: () => local.resources,
}));
const review = vi.hoisted(() => ({
  controller: { inlineReview: null },
  reviewRoomNameForDraft: () => null,
  setActiveEditorDocumentId: () => {},
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({ useDraftReview: () => review }));
vi.mock("@/features/editor/EditorView", () => ({
  EditorView: () => <textarea aria-label="Editor" defaultValue="keep writing" />,
}));

it("keeps the editor and caret when a local resource gains server metadata", async () => {
  let publish!: () => void;
  const opener = {
    open: vi.fn(),
  };
  function Harness() {
    const [published, setPublished] = useState(false);
    publish = () => setPublished(true);
    const tab: ContextTab = published
      ? {
          tabInstanceId: "member",
          kind: "tracked",
          documentId: "document",
          name: "Untitled 1.md",
          scheme: "unfiled",
          path: "/Untitled 1.md",
          editable: true,
          filetype: "markdown",
          schemaType: "document",
          resourceHandle: "resource-document",
          origin: "local-resource",
        }
      : {
          tabInstanceId: "member",
          kind: "new",
          documentId: "document",
          name: "Untitled",
          resourceHandle: "resource-document",
        };
    return (
      <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
        <ContextEditorMountHost
          projectId="project"
          workId={null}
          trackedTabs={[tab]}
          activeTabId="document"
          active
        />
      </ProjectDocumentLiveOpenerContext.Provider>
    );
  }
  await withReactRoot(<Harness />, async () => {
    const editor = document.querySelector("textarea");
    if (!editor) throw new Error("Local editor did not mount");
    editor.focus();
    editor.setSelectionRange(4, 4);
    expect(opener.open).not.toHaveBeenCalled();
    await act(async () => publish());
    expect(document.querySelector("textarea")).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(4);
  });
  expect(opener.open).not.toHaveBeenCalled();
});

it("keeps the server editor and caret while its local cache becomes authoritative", async () => {
  let publish!: () => void;
  const release = vi.fn();
  const opener = {
    open: vi.fn(async () => ({
      kind: "opened" as const,
      document: {},
      admission: {
        projectId: "project",
        documentId: "document",
        generation: "1",
        bind: async () => ({
          projectId: "project",
          documentId: "document",
          generation: "1",
          session: local.session,
          release,
        }),
      },
    })),
  };
  function Harness() {
    const [cached, setCached] = useState(false);
    publish = () => setCached(true);
    const tab: ContextTab = {
      tabInstanceId: "member",
      kind: "tracked",
      documentId: "document",
      name: "Chapter.md",
      scheme: "manuscript",
      path: "/Chapter.md",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
      ...(cached ? { resourceHandle: "resource-document", origin: "local-resource" } : {}),
    };
    return (
      <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
        <ContextEditorMountHost
          projectId="project"
          workId={null}
          trackedTabs={[tab]}
          activeTabId="document"
          active
        />
      </ProjectDocumentLiveOpenerContext.Provider>
    );
  }

  await withReactRoot(<Harness />, async () => {
    await vi.waitFor(() => expect(document.querySelector("textarea")).not.toBeNull());
    const editor = document.querySelector("textarea");
    if (!editor) throw new Error("Server editor did not mount");
    editor.focus();
    editor.setSelectionRange(4, 4);
    await act(async () => publish());
    await vi.waitFor(() =>
      expect(local.resources.openDocument).toHaveBeenLastCalledWith(
        "project",
        { handle: "resource-document" },
        expect.any(String),
        expect.any(AbortSignal),
      ),
    );
    expect(document.querySelector("textarea")).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(4);
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });
});
