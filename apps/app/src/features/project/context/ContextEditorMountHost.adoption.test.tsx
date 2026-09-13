// @vitest-environment jsdom
/** Local publication changes document metadata, not the mounted editor or its selection. */
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import type { DocumentSession } from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextEditorMountHost } from "./ContextEditorMountHost";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";

const local = vi.hoisted(() => ({
  session: { suspendPresence() {}, resumePresence() {} },
}));
vi.mock("./account-feature-context", () => ({
  useLocalUntitledOwner: () => ({
    accountId: "account",
    getDetached: () => local,
    retain() {},
    release() {},
  }),
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

it("keeps the editor and caret through delayed binding of the same adopted session", async () => {
  let publish!: () => void;
  let settle!: (value: Awaited<ReturnType<typeof bind>>) => void;
  const release = vi.fn();
  const bind = vi.fn(
    () =>
      new Promise<{
        projectId: string;
        documentId: string;
        generation: string;
        session: DocumentSession;
        release: () => void;
      }>((resolve) => {
        settle = resolve;
      }),
  );
  const opener = {
    open: vi.fn(async () => ({
      kind: "opened" as const,
      document: {} as never,
      admission: { projectId: "project", documentId: "document", generation: "1", bind },
    })),
  };
  function Harness() {
    const [published, setPublished] = useState(false);
    publish = () => setPublished(true);
    const tab: ContextTab = published
      ? {
          kind: "tracked",
          documentId: "document",
          name: "Untitled 1.md",
          scheme: "unfiled",
          path: "/Untitled 1.md",
          editable: true,
          filetype: "markdown",
          schemaType: "document",
          origin: "local-untitled",
        }
      : { kind: "new", documentId: "document", name: "Untitled" };
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
    await act(async () =>
      settle({
        projectId: "project",
        documentId: "document",
        generation: "1",
        session: local.session as DocumentSession,
        release,
      }),
    );
    expect(document.querySelector("textarea")).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(4);
  });
  expect(release).toHaveBeenCalledOnce();
});
