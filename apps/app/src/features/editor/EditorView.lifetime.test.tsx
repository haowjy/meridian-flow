// @vitest-environment jsdom
/** Writer edits, undo history, and read-only fencing survive editor surface changes. */

import type { Work } from "@meridian/contracts/works";
import type { Editor } from "@tiptap/core";
import { act, StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { resolveDocumentLink } from "@/client/api/document-links-api";
import { getLinkSurface } from "@/core/editor/links";
import { createProjectLinkResolver } from "@/features/links/project-link-resolver";
import {
  raiseSchemaFence,
  registry,
  sessionFor,
  sessionHorizons,
  sessionSnapshots,
  setConnectionState,
} from "@/test-support/editor-session-fakes";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { EditorViewProps } from "./EditorView";
import { type EditorScope, useEditorScope } from "./editor-scope";

const noWork = { id: "no-work", slug: null, archivedAt: null } as Work;
const namedWork = { id: "named-work", slug: "named", archivedAt: null } as Work;
let holderScheme = "manuscript";
let holderProjectionReady = true;
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
  useDraftReview: () => ({ controller }),
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
                workId:
                  holderScheme === "scratch" || holderScheme === "uploads" ? namedWork.id : null,
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

const { EditorView } = await import("./EditorView");

/** The mounted instance, read the way the browser probe reads it. */
function mountedEditor(): Editor {
  const dom = document.querySelector<HTMLElement & { editor?: Editor }>(".ProseMirror");
  if (!dom?.editor) throw new Error("no mounted editor");
  return dom.editor;
}

let applyProps: (next: Partial<EditorViewProps>) => void = () => {};

function Harness({ initial }: { initial: EditorViewProps }) {
  const [props, setProps] = useState(initial);
  applyProps = (next) => setProps((previous) => ({ ...previous, ...next }));
  return <EditorView {...props} session={props.session ?? sessionFor(props.documentId)} />;
}

function ExactLiveEditor(props: EditorViewProps) {
  return <EditorView {...props} session={props.session ?? sessionFor(props.documentId)} />;
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
    await withReactRoot(
      "reviewRoomName" in props ? <EditorView {...props} /> : <ExactLiveEditor {...props} />,
      async () => {
        expect(mountedEditor()).toBeDefined();
        const roomKey = "reviewRoomName" in props ? props.reviewRoomName : props.documentId;
        expect(sessionSnapshots.get(roomKey)?.schemaRepairs).toEqual([]);
        expect(document.querySelector("[data-schema-repair-notice]")).toBeNull();
      },
    );
  });

  it("double-mounts valid content under StrictMode with zero repair verdicts", async () => {
    const documentId = "clean-strict-mode";
    await withReactRoot(
      <StrictMode>
        <ExactLiveEditor documentId={documentId} projectId="project-1" />
      </StrictMode>,
      async () => {
        expect(mountedEditor()).toBeDefined();
        expect(sessionSnapshots.get(documentId)?.schemaRepairs).toEqual([]);
      },
    );
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

  it("opens read-only when the surface asks for it — the phone must not mount editable", async () => {
    const initial = { documentId: "document-3", projectId: "project-1", editable: false };
    await withReactRoot(<Harness initial={initial} />, async () => {
      expect(mountedEditor().isEditable).toBe(false);
      expect(mountedEditor().view.dom.getAttribute("contenteditable")).toBe("false");
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

describe("holder-owned Editor link scope", () => {
  it.each([
    "manuscript",
    "kb",
    "user",
    "unfiled",
    "scratch",
    "uploads",
  ])("%s links use the holder's Work", async (scheme) => {
    holderScheme = scheme;
    const expectedWork = scheme === "scratch" || scheme === "uploads" ? namedWork : noWork;
    await withReactRoot(
      <Harness initial={{ documentId: "holder", projectId: "project-1" }} />,
      async () => {
        expect(observedScope.workId).toBe(expectedWork.id);
        expect(indexedWorkId).toBe(expectedWork.id);
        expect(referenceWorkId).toBe(expectedWork.id);
        const index = { documents: [], revision: "", complete: false };
        vi.mocked(resolveDocumentLink).mockResolvedValue({ document: null });
        const target = { kind: "scheme" as const, uri: "scratch://x.md" };
        await createProjectLinkResolver(
          {
            ...observedScope,
            projectId: "project-1",
            workId: observedScope.workId ?? "unresolved",
            baseUri: null,
          },
          index,
        )(target);
        expect(resolveDocumentLink).toHaveBeenLastCalledWith(
          "project-1",
          expect.objectContaining({ workId: expectedWork.id }),
        );
      },
    );
    holderScheme = "manuscript";
  });

  describe("a follow while the holder's resource record is still arriving", () => {
    const target = { kind: "scheme" as const, uri: "manuscript://existing.md" };
    const existing = {
      documentId: "target",
      title: "Existing",
      scheme: "manuscript" as const,
      path: "existing.md",
      uri: "manuscript://existing.md",
      workId: null,
    };
    const hydrate = async (
      follow: (surface: NonNullable<ReturnType<typeof getLinkSurface>>) => void,
    ) => {
      holderProjectionReady = false;
      try {
        await withReactRoot(
          <Harness initial={{ documentId: "holder", projectId: "project-1" }} />,
          async () => {
            vi.mocked(resolveDocumentLink).mockClear();
            openDocument.mockClear();
            vi.mocked(resolveDocumentLink).mockResolvedValue({ document: existing });
            const surface = getLinkSurface(mountedEditor());
            if (!surface?.navigator) throw new Error("No link navigator");
            await act(async () => {
              surface.navigator?.({ target, disposition: "current" });
              await new Promise((resolve) => setTimeout(resolve, 300));
            });
            // Asked of nobody yet, but the writer is told it is being checked.
            expect(surface.state.follow?.state).toBe("checking");
            expect(resolveDocumentLink).not.toHaveBeenCalled();
            follow(surface);
            await act(async () => {
              holderProjectionReady = true;
              applyProps({});
            });
          },
        );
      } finally {
        holderProjectionReady = true;
      }
    };

    it("opens once when the holder's Work arrives", async () => {
      await hydrate(() => {});
      expect(resolveDocumentLink).toHaveBeenCalledTimes(1);
      expect(openDocument).toHaveBeenCalledTimes(1);
      expect(openDocument).toHaveBeenCalledWith(expect.objectContaining({ documentId: "target" }));
    });

    it("opens nothing after the writer dismissed the wait", async () => {
      await hydrate((surface) => act(() => surface.dismissFollow()));
      expect(resolveDocumentLink).not.toHaveBeenCalled();
      expect(openDocument).not.toHaveBeenCalled();
    });
  });
});
