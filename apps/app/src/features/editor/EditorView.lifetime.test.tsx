// @vitest-environment jsdom
/** Writer edits, undo history, and read-only fencing survive editor surface changes. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as threads from "@/client/query/useProjectThreads";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { createEditorSessions } from "@/test-support/editor-sessions";
import { installEditorShell } from "@/test-support/editor-shell";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { EditorViewProps } from "./EditorView";

let shell: ReturnType<typeof installEditorShell>;
let sessions: ReturnType<typeof createEditorSessions>;
beforeEach(() => {
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

/** Runtime callbacks are inert; these tests own only editor lifetime and surface selection. */
const controller = {
  registerInlineReviewRuntime: () => {},
  releaseInlineReviewRuntime: () => {},
  inlineReviewModelAvailable: () => {},
  setInlineReviewShown: () => {},
  inlineReview: null as
    | import("@/features/draft-review/draft-review-session").InlineDraftReview
    | null,
  reviewRoomError: false,
};

vi.mock("@/features/draft-review/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller,
    roomOwner: { session: null },
  }),
}));

const reviewHooks = vi.hoisted(() => ({ sync: vi.fn(), focus: vi.fn() }));
vi.mock("./useInlineReviewSync", () => ({ useInlineReviewSync: reviewHooks.sync }));
vi.mock("./useInlineReviewFocus", () => ({ useInlineReviewFocus: reviewHooks.focus }));

const openDocument = vi.hoisted(() => vi.fn());
vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => openDocument,
}));

const queryClient = new QueryClient();
const { EditorView } = await import("./EditorView");

/** The mounted instance, read the way the browser probe reads it. */
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
      <EditorView {...props} session={props.session ?? sessions.get(props.documentId)} />
    </QueryClientProvider>
  );
}

describe("editor lifetime", () => {
  it("keeps the pending shell until persistence and first server sync both finish", async () => {
    const documentId = "horizon-controlled";
    let resolvePersistence!: () => void;
    let resolveServer!: () => void;
    const horizons = {
      localPersistence: new Promise<void>((resolve) => {
        resolvePersistence = resolve;
      }),
      firstServerSync: new Promise<void>((resolve) => {
        resolveServer = resolve;
      }),
    };
    vi.spyOn(sessions.get(documentId), "whenLocalPersistenceSynced").mockReturnValue(
      horizons.localPersistence,
    );
    vi.spyOn(sessions.get(documentId), "whenSynced").mockReturnValue(horizons.firstServerSync);

    await withReactRoot(<ExactLiveEditor documentId={documentId} />, async () => {
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
      expect(reviewHooks.sync).not.toHaveBeenCalled();
      expect(reviewHooks.focus).not.toHaveBeenCalled();
    });
  });

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
      // A thread-list refetch hands the tree a brand-new array on every turn.
      await act(async () => {
        threadList.current = [{ id: "thread-1", title: "Chapter voice — revised" }];
        applyProps({});
      });
      expect(mountedEditor().getText()).toBe("words the writer typed");

      // Surface changes preserve the pending edit and its undo history.
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
        expect(mountedEditor().commands.undo()).toBe(true);
      });
      expect(mountedEditor().getText()).toBe("");
      await act(async () => {
        expect(mountedEditor().commands.redo()).toBe(true);
      });
      expect(mountedEditor().getText()).toBe("words the writer typed");

      // Navigating to another room must not carry this document's content or undo.

      await act(async () => {
        applyProps({ documentId: "document-2" });
      });
      expect(mountedEditor().getText()).toBe("");
      await act(async () => {
        expect(mountedEditor().commands.undo()).toBe(false);
      });
      expect(mountedEditor().getText()).toBe("");
    });
  });

  it("preserves typed content and becomes read-only when its session is fenced", async () => {
    const initial = {
      documentId: "document-fenced",
      projectId: "project-1",
      localContentReady: true,
    };
    await withReactRoot(<Harness initial={initial} />, async () => {
      expect(mountedEditor().isEditable).toBe(true);
      await act(async () => {
        mountedEditor().commands.insertContent("Fenced words");
      });

      await act(async () => {
        sessions.get("document-fenced").raiseSchemaFence({ reason: "client-superseded" });
      });

      expect(mountedEditor().getText()).toBe("Fenced words");
      expect(mountedEditor().isEditable).toBe(false);
      expect(mountedEditor().view.dom.getAttribute("contenteditable")).toBe("false");
      expect(document.querySelector("[data-schema-fence]")?.textContent).toBe(
        "This chapter was opened in a newer version of Meridian. Refresh to keep writing.",
      );
    });
  });
});

it("does not attribute the leaving review's room error to an incoming request", async () => {
  controller.inlineReview = {
    kind: "inline",
    documentId: "leaving",
    draftId: "failed-draft",
    roomError: true,
  };
  controller.reviewRoomError = true;
  try {
    await withReactRoot(
      <Harness
        initial={{
          documentId: "incoming",
          projectId: "project-1",
          reviewDraftId: "incoming-draft",
        }}
      />,
      () => {
        expect(document.body.textContent).not.toContain("Couldn't open review mode.");
        expect(
          document.querySelector('[data-editor-surface="live"]')?.classList.contains("hidden"),
        ).toBe(true);
      },
    );
  } finally {
    controller.inlineReview = null;
    controller.reviewRoomError = false;
  }
});
