// @vitest-environment jsdom
/** Writer edits, undo history, and read-only fencing survive editor surface changes. */

import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  raiseSchemaFence,
  registry,
  sessionFor,
  sessionHorizons,
} from "@/test-support/editor-session-fakes";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { EditorViewProps } from "./EditorView";
import { type EditorScope, useEditorScope } from "./editor-scope";

const noWork = { id: "no-work", slug: null, archivedAt: null } as Work;
const namedWork = { id: "named-work", slug: "named", archivedAt: null } as Work;
const holderScheme = "manuscript";
const holderProjectionReady = true;
let observedScope: EditorScope;
let indexedWorkId: string | null;
let referenceWorkId: string | null;
vi.mock("./references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: (_projectId: string, workId: string | null) => {
    referenceWorkId = workId;
    return null;
  },
}));
vi.mock("@/client/api/document-links-api", () => ({ resolveDocumentLink: vi.fn() }));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ noWork, works: [namedWork] }),
}));

type ThreadListItem = { id: string; title: string | null };

const threadList: { current: ThreadListItem[] } = {
  current: [{ id: "thread-1", title: "Chapter voice" }],
};

/** Lifetime is not about review: no review is ever open here, and nothing reports about one. */
const controller = {
  registerInlineReviewRuntime: () => {},
  releaseInlineReviewRuntime: () => {},
  inlineReviewModelAvailable: () => {},
  setInlineReviewShown: () => {},
  inlineReview: null,
};

vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: threadList.current, isError: false, isFetching: false }),
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  useContextCatalogView: () => ({
    catalog: null,
    isError: false,
    isFetching: false,
    refetch: () => {},
  }),
}));
vi.mock("@/features/change-trail/trail-detail-query", () => ({
  usePrefetchTrailDetails: () => {},
}));
vi.mock("@/features/draft-review/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller,
    roomOwner: { session: null, onBeforeReplace: () => () => {} },
  }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useLiveDocumentSessionRegistry: () => registry,
  useOptionalAccountResourceReplica: () => null,
  useAccountResourceProjection: () => ({
    snapshot: null,
    records: holderProjectionReady
      ? [
          {
            resource: {
              identity: { documentId: "holder" },
              aliases: {},
              lifecycle: { kind: "acknowledged" },
              obligations: {},
              canonical: {
                scheme: holderScheme,
                path: "/holder.md",
                name: "holder.md",
                workId: null,
                workSlug: "named",
              },
            },
            intents: [],
          },
        ]
      : [],
    error: null,
  }),
}));
vi.mock("./useInlineReviewSync", () => ({ useInlineReviewSync: () => {} }));
vi.mock("./useInlineReviewFocus", () => ({ useInlineReviewFocus: () => {} }));
vi.mock("./SyncStatus", () => ({ SyncStatus: () => null }));
// The real runtime and follower, with only the scope it reads observed.
vi.mock("./surfaces/link", async () => {
  const { ProjectLinkRuntime: Runtime } = await import("./surfaces/link/ProjectLinkRuntime");
  return {
    ProjectLinkRuntime: (props: React.ComponentProps<typeof Runtime>) => {
      observedScope = useEditorScope();
      return <Runtime {...props} />;
    },
  };
});
const openDocument = vi.hoisted(() => vi.fn());
vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => openDocument,
}));
vi.mock("@/features/links", async () => ({
  useLinkFollower: (await import("@/features/links/use-link-follower")).useLinkFollower,
  useLinkableDocuments: (scope: EditorScope) => {
    indexedWorkId = scope.workId;
    return { documents: [], revision: "", complete: false };
  },
}));
// Lifetime is about which editor exists, not what hangs off it. An empty
// registry keeps every lane's own dependencies out of this suite.
vi.mock("./chrome/chrome-surfaces", () => ({ EDITOR_CHROME_SURFACES: [] }));

const queryClient = new QueryClient();
const { EditorView } = await import("./EditorView");

/** The mounted instance, read the way the browser probe reads it. */
function mountedEditor(): Editor {
  const dom = document.querySelector<HTMLElement & { editor?: Editor }>(".ProseMirror");
  if (!dom?.editor) throw new Error("no mounted editor");
  return dom.editor;
}

type LiveProps = Omit<EditorViewProps, "reviewDraftId" | "onReviewRoomStale">;
let applyProps: (next: Partial<LiveProps>) => void = () => {};

function Harness({ initial }: { initial: LiveProps }) {
  const [props, setProps] = useState(initial);
  applyProps = (next) => setProps((previous) => ({ ...previous, ...next }));
  return (
    <QueryClientProvider client={queryClient}>
      <EditorView {...props} session={props.session ?? sessionFor(props.documentId)} />
    </QueryClientProvider>
  );
}

function ExactLiveEditor(props: LiveProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <EditorView {...props} session={props.session ?? sessionFor(props.documentId)} />
    </QueryClientProvider>
  );
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
    });
  });

  it("binds verified local content without waiting for an offline server sync", async () => {
    const documentId = "local-horizon-controlled";
    let resolvePersistence!: () => void;
    sessionHorizons.set(documentId, {
      localPersistence: new Promise((resolve) => {
        resolvePersistence = resolve;
      }),
      firstServerSync: new Promise(() => undefined),
    });

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
    const initial = { documentId: "document-1", projectId: "project-1" };
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
    const initial = { documentId: "document-fenced", projectId: "project-1" };
    await withReactRoot(<Harness initial={initial} />, async () => {
      expect(mountedEditor().isEditable).toBe(true);
      await act(async () => {
        mountedEditor().commands.insertContent("Fenced words");
      });

      await act(async () => {
        raiseSchemaFence("document-fenced", { reason: "client-superseded" });
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
