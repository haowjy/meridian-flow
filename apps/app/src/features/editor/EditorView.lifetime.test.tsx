// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as threads from "@/client/query/useProjectThreads";
import { ThreadStoreProvider } from "@/client/stores";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { redoEditorHistory, undoEditorHistory } from "@/core/editor/editor-history";
import { createEditorSessions } from "@/test-support/editor-sessions";
import { installEditorShell } from "@/test-support/editor-shell";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { EditorViewProps } from "./EditorView";

let shell: ReturnType<typeof installEditorShell>;
let sessions: ReturnType<typeof createEditorSessions>;
beforeEach(() => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  sessions = createEditorSessions();
  shell = installEditorShell(sessions.registry as unknown as LiveDocumentSessionRegistry);
  vi.spyOn(threads, "useProjectThreads").mockImplementation(() => ({
    threads: threadList.current as ReturnType<typeof threads.useProjectThreads>["threads"],
    isError: false,
    isFetching: false,
    refetch: () => {},
  }));
});
afterEach(async () => {
  shell.dispose();
  await sessions.dispose();
});

type ThreadListItem = { id: string; title: string | null };

const threadList: { current: ThreadListItem[] } = {
  current: [{ id: "thread-1", title: "Chapter voice" }],
};

const controller = { draftId: "" };

vi.mock("@/features/draft-review/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller,
    fileForDocument: () => null,
  }),
}));

const openDocument = vi.hoisted(() => vi.fn());
vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => openDocument,
  useProjectDocumentNavigationProjectId: () => "project-a",
}));

const queryClient = new QueryClient();
const { EditorView } = await import("./EditorView");

function mountedEditor(): Editor {
  const dom = document.querySelector<HTMLElement & { editor?: Editor }>(".ProseMirror");
  if (!dom?.editor) throw new Error("no mounted editor");
  return dom.editor;
}

type SurfaceProps = EditorViewProps;
let applyProps: (next: Partial<SurfaceProps>) => void = () => {};

function Harness({ initial }: { initial: SurfaceProps }) {
  const [props, setProps] = useState(initial);
  applyProps = (next) => setProps((previous) => ({ ...previous, ...next }));
  return <ExactLiveEditor {...props} />;
}

function ExactLiveEditor(props: SurfaceProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThreadStoreProvider now={0}>
        <I18nProvider i18n={i18n}>
          <EditorView {...props} session={props.session ?? sessions.get(props.documentId)} />
        </I18nProvider>
      </ThreadStoreProvider>
    </QueryClientProvider>
  );
}

describe("editor lifetime", () => {
  it("binds verified local content without waiting for an offline server sync", async () => {
    const documentId = "local-horizon-controlled";
    let resolvePersistence!: () => void;
    const horizons = {
      localPersistence: new Promise<void>((resolve) => {
        resolvePersistence = resolve;
      }),
      firstServerSync: new Promise<void>(() => undefined),
    };
    vi.spyOn(sessions.get(documentId), "whenLocalPersistenceSynced").mockReturnValue(
      horizons.localPersistence,
    );
    vi.spyOn(sessions.get(documentId), "whenSynced").mockReturnValue(horizons.firstServerSync);

    await withReactRoot(<ExactLiveEditor documentId={documentId} localContentReady />, async () => {
      expect(document.querySelector(".ProseMirror")).toBeNull();
      await act(async () => {
        resolvePersistence();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mountedEditor()).toBeDefined();
    });
  });

  it("preserves content and undo through query churn and surface changes without leaking into a new room", async () => {
    const initial = { documentId: "document-1", projectId: "project-1", localContentReady: true };
    await withReactRoot(<Harness initial={initial} />, async () => {
      await act(async () => {
        mountedEditor().commands.insertContent("words the writer typed");
      });
      await act(async () => {
        threadList.current = [{ id: "thread-1", title: "Chapter voice — revised" }];
        applyProps({});
      });
      expect(mountedEditor().getText()).toBe("words the writer typed");

      await act(async () => {
        applyProps({ editable: false, ariaLabel: "Read-only live document" });
      });
      const afterSurfaceChange = mountedEditor();
      expect(afterSurfaceChange.getText()).toBe("words the writer typed");
      expect(afterSurfaceChange.isEditable).toBe(false);
      expect(afterSurfaceChange.view.dom.getAttribute("aria-label")).toBe(
        "Read-only live document",
      );

      await act(async () => {
        applyProps({ editable: true });
      });
      await act(async () => {
        expect(undoEditorHistory(mountedEditor())).toBe(true);
      });
      expect(mountedEditor().getText()).toBe("");
      await act(async () => {
        expect(redoEditorHistory(mountedEditor())).toBe(true);
      });
      expect(mountedEditor().getText()).toBe("words the writer typed");

      await act(async () => {
        applyProps({ documentId: "document-2" });
      });
      expect(mountedEditor().getText()).toBe("");
      await act(async () => {
        expect(undoEditorHistory(mountedEditor())).toBe(false);
      });
      expect(mountedEditor().getText()).toBe("");
    });
  });
});
