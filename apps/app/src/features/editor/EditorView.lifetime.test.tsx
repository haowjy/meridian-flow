// @vitest-environment jsdom
/** Writer edits, undo history, and read-only fencing survive editor surface changes. */

import type { Work } from "@meridian/contracts/works";
import type { Editor } from "@tiptap/core";
import { act, StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { resolveDocumentLink } from "@/client/api/document-links-api";
import type {
  DocumentSession,
  DocumentSessionConnectionState,
  DocumentSessionSnapshot,
  SchemaFence,
} from "@/core/editor/document-session";
import { getLinkSurface } from "@/core/editor/links";
import { createLocalPresence } from "@/core/editor/local-presence";
import type { SchemaRepairEvent } from "@/core/editor/schema-repair-witness";
import { SessionMarkerStore } from "@/core/editor/session-marker-store";
import { createProjectLinkResolver } from "@/features/links/project-link-resolver";
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
    serverHasLocalChanges: false,
    connectionState: null,
    access: "edit",
    localPersistenceSynced: true,
    adoptionStalled: false,
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
    presence: createLocalPresence(awareness),
    markerStore: new SessionMarkerStore("writer"),
    refusedLocalEdits: () => refusedRooms.has(roomKey),
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

/** Rooms whose pending edits the server refused: the review rebuilds them from server state. */
const refusedRooms = new Set<string>();
let rebuild: { resolve: (session: DocumentSession) => void; reject: () => void } | null = null;
/** A fresh session for `roomKey`: the rebuild's result once the server state has synced. */
function finishRebuild(roomKey: string): void {
  refusedRooms.delete(roomKey);
  sessions.delete(roomKey);
  rebuild?.resolve(sessionFor(roomKey));
  rebuild = null;
}

function failRebuild(): void {
  rebuild?.reject();
  rebuild = null;
}

const unavailable = vi.fn();
const registry = {
  rebuildBranchRoom: () =>
    new Promise<DocumentSession>((resolve, reject) => {
      rebuild = { resolve, reject };
    }),
  retain: () => {},
  release: () => {},
  getRoom: sessionFor,
  has: () => false,
  get: sessionFor,
  retainBranchRooms: () => {},
  releaseBranchRooms: () => {},
  getBranchRoom: sessionFor,
};

const setInlineReviewShown = vi.fn();
const controller: {
  registerInlineReviewRuntime: () => void;
  releaseInlineReviewRuntime: () => void;
  inlineReviewModelAvailable: () => void;
  setInlineReviewShown: typeof setInlineReviewShown;
  inlineReview: {
    kind: "inline";
    documentId: string;
    draftId: string;
    previewIdentity?: string;
    cleared?: { documentName: string | null };
  } | null;
} = {
  registerInlineReviewRuntime: () => {},
  releaseInlineReviewRuntime: () => {},
  inlineReviewModelAvailable: () => {},
  setInlineReviewShown,
  inlineReview: null,
};
/** Whether the review's change marks have arrived; the controller reports it as `previewIdentity`. */
let reviewMarksAvailable = true;
/** The writer handled the last change: the controller marks the review finished. */
let reviewFinished = false;

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
vi.mock("@/features/chat/DraftReviewProvider", () => ({
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
  controller.inlineReview = props.reviewDraftId
    ? {
        kind: "inline",
        documentId: props.documentId,
        draftId: props.reviewDraftId,
        ...(reviewMarksAvailable ? { previewIdentity: "preview-1" } : {}),
        ...(reviewFinished ? { cleared: { documentName: "Doc" } } : {}),
      }
    : null;
  const session = props.reviewDraftId
    ? props.session
    : (props.session ?? sessionFor(props.documentId));
  return <EditorView {...props} session={session} />;
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

  it("never shows an empty body between live and review: live stays until review paints, then Apply reveals the warm live editor", async () => {
    const documentId = "continuity-doc";
    const roomName = "branch:continuity-doc:gen:1";
    let resolveReviewSync!: () => void;
    sessionHorizons.set(roomName, {
      localPersistence: Promise.resolve(),
      firstServerSync: new Promise((resolve) => {
        resolveReviewSync = resolve;
      }),
    });
    const visibleEditors = () =>
      [...document.querySelectorAll<HTMLElement>(".ProseMirror")].filter(
        (dom) => !dom.closest(".hidden"),
      );
    const visibleText = () => visibleEditors().map((dom) => dom.textContent);
    const empty: string[] = [];
    const observer = new MutationObserver(() => {
      if (visibleEditors().length !== 1) empty.push(`${visibleEditors().length} visible editors`);
    });

    const initial = { documentId, projectId: "project-1", session: sessionFor(documentId) };
    await withReactRoot(<Harness initial={initial} />, async () => {
      await act(async () => {
        mountedEditor().commands.insertContent("live words");
      });
      const liveDom = mountedEditor().view.dom;
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      // The review room is still syncing: the live manuscript stays on screen.
      await act(async () => {
        applyProps({ reviewDraftId: "draft-1", reviewRoomName: roomName });
      });
      expect(visibleText()).toEqual(["live words"]);

      // Review paints in one step.
      await act(async () => {
        resolveReviewSync();
        await Promise.resolve();
        await Promise.resolve();
      });
      const reviewDom = [
        ...document.querySelectorAll<HTMLElement & { editor?: Editor }>(".ProseMirror"),
      ].find((dom) => dom !== liveDom);
      expect(visibleEditors()).toEqual([reviewDom]);

      // Apply: review goes straight to the same warm live editor.
      await act(async () => {
        applyProps({ reviewDraftId: null, reviewRoomName: null });
      });
      expect(visibleEditors()).toEqual([liveDom]);
      expect(visibleText()).toEqual(["live words"]);
      observer.disconnect();
      expect(empty).toEqual([]);
    });
  });

  describe("holding the live view until the review has its marks", () => {
    const documentId = "hold-doc";
    const roomName = "branch:hold-doc:gen:1";
    const surfaces = () =>
      [...document.querySelectorAll<HTMLElement>("[data-editor-surface]")]
        .filter((wrapper) => !wrapper.classList.contains("hidden"))
        .map((wrapper) => wrapper.dataset.editorSurface);

    afterEach(() => {
      reviewMarksAvailable = true;
      reviewFinished = false;
      setInlineReviewShown.mockClear();
      vi.useRealTimers();
    });

    async function enterReview(): Promise<void> {
      sessionHorizons.set(roomName, {
        localPersistence: Promise.resolve(),
        firstServerSync: Promise.resolve(),
      });
      await act(async () => {
        applyProps({ reviewDraftId: "draft-hold", reviewRoomName: roomName });
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it("keeps live on screen, chrome unreported, after the editor exists but before its marks", async () => {
      reviewMarksAvailable = false;
      const initial = { documentId, projectId: "project-1", session: sessionFor(documentId) };
      await withReactRoot(<Harness initial={initial} />, async () => {
        await enterReview();
        expect(surfaces()).toEqual(["live"]);
        expect(setInlineReviewShown).not.toHaveBeenCalledWith(documentId, "draft-hold", true);

        // The marks arrive: body and chrome flip together.
        reviewMarksAvailable = true;
        await act(async () => {
          applyProps({});
        });
        expect(surfaces()).toEqual(["review"]);
        expect(setInlineReviewShown).toHaveBeenLastCalledWith(documentId, "draft-hold", true);
      });
    });

    it("reveals the warm live editor, editable, when the review is finished, with its chrome still up", async () => {
      const initial = { documentId, projectId: "project-1", session: sessionFor(documentId) };
      await withReactRoot(<Harness initial={initial} />, async () => {
        const liveDom = mountedEditor().view.dom;
        await enterReview();
        expect(surfaces()).toEqual(["review"]);
        expect(liveDom.getAttribute("contenteditable")).toBe("false");
        setInlineReviewShown.mockClear();

        // The last change was handled: the draft is live's text now.
        reviewFinished = true;
        await act(async () => {
          applyProps({});
        });
        expect(surfaces()).toEqual(["live"]);
        // The same editor, not a rebuilt one, and the writer can type in it again.
        expect(mountedEditor().view.dom).toBe(liveDom);
        expect(liveDom.getAttribute("contenteditable")).toBe("true");
        // The review's chrome (header, "No changes left") never drops out.
        expect(setInlineReviewShown).not.toHaveBeenCalledWith(documentId, "draft-hold", false);
      });
    });

    it("shows the review anyway when its marks never arrive", async () => {
      reviewMarksAvailable = false;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const initial = { documentId, projectId: "project-1", session: sessionFor(documentId) };
      await withReactRoot(<Harness initial={initial} />, async () => {
        await enterReview();
        expect(surfaces()).toEqual(["live"]);
        await act(async () => {
          vi.advanceTimersByTime(1600);
        });
        expect(surfaces()).toEqual(["review"]);
      });
    });
  });

  it("keeps the painted review editor when the live binding is re-minted under it", async () => {
    // A rename re-mints the host's binding key for the live session. The branch
    // review has its own session, so it must neither remount nor hand the screen
    // back to the live text.
    const documentId = "rename-review-doc";
    const roomName = "branch:rename-review-doc:gen:1";
    sessionHorizons.set(roomName, {
      localPersistence: Promise.resolve(),
      firstServerSync: Promise.resolve(),
    });
    const initial = {
      documentId,
      projectId: "project-1",
      session: sessionFor(documentId),
      bindingKey: "binding-1",
    };
    await withReactRoot(<Harness initial={initial} />, async () => {
      await act(async () => {
        applyProps({ reviewDraftId: "draft-1", reviewRoomName: roomName });
        await Promise.resolve();
        await Promise.resolve();
      });
      const painted = [...document.querySelectorAll<HTMLElement>(".ProseMirror")].filter(
        (dom) => !dom.closest(".hidden"),
      );
      expect(painted).toHaveLength(1);

      await act(async () => {
        applyProps({ bindingKey: "binding-2" });
      });
      const after = [...document.querySelectorAll<HTMLElement>(".ProseMirror")].filter(
        (dom) => !dom.closest(".hidden"),
      );
      expect(after).toHaveLength(1);
      expect(after[0]).toBe(painted[0]);
    });
  });

  it("keeps the live manuscript painted but read-only from the Review click until the branch editor paints", async () => {
    const documentId = "pending-review-doc";
    const roomName = "branch:pending-review-doc:gen:1";
    sessionHorizons.set(roomName, {
      localPersistence: Promise.resolve(),
      firstServerSync: new Promise(() => undefined),
    });
    await withReactRoot(
      <Harness initial={{ documentId, session: sessionFor(documentId) }} />,
      async () => {
        const live = mountedEditor();
        await act(async () => {
          live.commands.insertContent("live words");
        });

        // Review is intended but its room is still resolving, then still syncing.
        await act(async () => {
          applyProps({ reviewDraftId: "draft-pending" });
        });
        expect(live.isEditable).toBe(false);
        expect(live.view.dom.closest(".hidden")).toBeNull();
        await act(async () => {
          applyProps({ reviewRoomName: roomName });
        });
        expect(live.isEditable).toBe(false);
        expect(live.view.dom.closest(".hidden")).toBeNull();
        expect(live.getText()).toBe("live words");

        // Leaving review restores writing on the same warm editor.
        await act(async () => {
          applyProps({ reviewDraftId: null, reviewRoomName: null });
        });
        expect(mountedEditor()).toBe(live);
        expect(live.isEditable).toBe(true);
      },
    );
  });

  it("shows the pending shell for a draft-only review, with no live editor to keep painted", async () => {
    const roomName = "branch:draft-only:gen:1";
    sessionHorizons.set(roomName, {
      localPersistence: Promise.resolve(),
      firstServerSync: new Promise(() => undefined),
    });
    await withReactRoot(
      <EditorView documentId="draft-only" reviewDraftId="draft-only-1" reviewRoomName={roomName} />,
      async () => {
        const shells = [...document.querySelectorAll(".meridian-editor-shell")];
        expect(shells).toHaveLength(1);
        expect(shells.filter((shell) => !shell.closest(".hidden"))).toHaveLength(1);
      },
    );
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

  describe("a refused branch room rebuilt under a painted review", () => {
    const visibleEditors = () =>
      [...document.querySelectorAll<HTMLElement & { editor?: Editor }>(".ProseMirror")].filter(
        (dom) => !dom.closest(".hidden"),
      );
    const visibleText = () =>
      [...document.querySelectorAll<HTMLElement>(".meridian-editor-shell")]
        .filter((shell) => !shell.closest(".hidden"))
        .map((shell) => shell.textContent);
    async function refuse(roomName: string) {
      refusedRooms.add(roomName);
      await act(async () => {
        setConnectionState(roomName, { kind: "reset", reason: "access-changed", code: 4409 });
      });
    }

    it("keeps the review on screen, inert, until the rebuilt room paints, and never shows live prose", async () => {
      const documentId = "rebuild-live-doc";
      const roomName = "branch:rebuild-live-doc:gen:1";
      const initial = { documentId, session: sessionFor(documentId) };
      await withReactRoot(<Harness initial={initial} />, async () => {
        await act(async () => {
          mountedEditor().commands.insertContent("LIVE MANUSCRIPT");
        });
        await act(async () => {
          applyProps({ reviewDraftId: "draft-rebuild", reviewRoomName: roomName });
        });
        await act(async () => {
          visibleEditors()[0]?.editor?.commands.insertContent("DRAFT REVIEW");
        });
        expect(visibleText()).toEqual(["DRAFT REVIEW"]);

        await refuse(roomName);
        // The replacement is still syncing: the review as painted stays, and nothing can type into it.
        expect(visibleText().join("")).toContain("DRAFT REVIEW");
        expect(visibleText().join("")).not.toContain("LIVE MANUSCRIPT");
        const held = document.querySelector("[data-review-replacing]");
        expect(held?.hasAttribute("inert")).toBe(true);
        expect(held?.getAttribute("aria-hidden")).toBe("true");
        expect(document.querySelectorAll("[data-review-replacing] .ProseMirror")).toHaveLength(1);
        expect(visibleEditors().filter((dom) => !dom.closest("[data-review-replacing]"))).toEqual(
          [],
        );

        // The rebuilt room paints: the held copy is gone and the review is a live editor again.
        await act(async () => {
          finishRebuild(roomName);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(document.querySelector("[data-review-replacing]")).toBeNull();
        expect(visibleEditors()).toHaveLength(1);
        expect(visibleEditors()[0]?.closest(".hidden")).toBeNull();
        expect(visibleText().join("")).not.toContain("LIVE MANUSCRIPT");
      });
    });

    it("holds the review for a draft-only document, which has no live prose to fall back to", async () => {
      const roomName = "branch:rebuild-draft-only:gen:1";
      await withReactRoot(
        <Harness
          initial={{
            documentId: "rebuild-draft-only",
            reviewDraftId: "draft-only-rebuild",
            reviewRoomName: roomName,
          }}
        />,
        async () => {
          await act(async () => {
            visibleEditors()[0]?.editor?.commands.insertContent("DRAFT ONLY REVIEW");
          });
          await refuse(roomName);
          expect(document.querySelectorAll(".meridian-editor-shell")).toHaveLength(1);
          expect(document.querySelector("[data-review-replacing]")?.textContent).toContain(
            "DRAFT ONLY REVIEW",
          );
        },
      );
    });

    it("hands the screen back to the live prose when the review is actually left", async () => {
      const documentId = "rebuild-leave-doc";
      const roomName = "branch:rebuild-leave-doc:gen:1";
      await withReactRoot(
        <Harness initial={{ documentId, session: sessionFor(documentId) }} />,
        async () => {
          await act(async () => {
            mountedEditor().commands.insertContent("LIVE MANUSCRIPT");
          });
          await act(async () => {
            applyProps({ reviewDraftId: "draft-leave", reviewRoomName: roomName });
          });
          await refuse(roomName);
          await act(async () => {
            applyProps({ reviewDraftId: null, reviewRoomName: null });
          });
          expect(document.querySelector("[data-review-replacing]")).toBeNull();
          expect(visibleText().join("")).toContain("LIVE MANUSCRIPT");
        },
      );
    });
    it("never shows the previous review's frozen prose under a different review identity", async () => {
      const roomA = "branch:frozen-switch-a:gen:1";
      const roomB = "branch:frozen-switch-b:gen:1";
      sessionHorizons.set(roomB, {
        localPersistence: Promise.resolve(),
        firstServerSync: new Promise(() => undefined),
      });
      await withReactRoot(
        <Harness
          initial={{
            documentId: "freeze-switch",
            reviewDraftId: "draft-a",
            reviewRoomName: roomA,
          }}
        />,
        async () => {
          await act(async () => {
            visibleEditors()[0]?.editor?.commands.insertContent("PRIVATE REVIEW A");
          });
          await refuse(roomA);
          expect(document.querySelector("[data-review-replacing]")?.textContent).toContain(
            "PRIVATE REVIEW A",
          );
          await act(async () => {
            applyProps({ reviewDraftId: "draft-b", reviewRoomName: roomB });
          });
          expect(document.body.textContent).not.toContain("PRIVATE REVIEW A");
        },
      );
    });

    it("ignores a retired rebuild finishing after another review has bound", async () => {
      const roomA = "branch:late-switch-a:gen:1";
      const roomB = "branch:late-switch-b:gen:1";
      await withReactRoot(
        <Harness
          initial={{ documentId: "late-switch", reviewDraftId: "draft-a", reviewRoomName: roomA }}
        />,
        async () => {
          await refuse(roomA);
          await act(async () => {
            applyProps({ reviewDraftId: "draft-b", reviewRoomName: roomB });
          });
          await act(async () => {
            visibleEditors()[0]?.editor?.commands.insertContent("REVIEW B");
          });
          await act(async () => {
            finishRebuild(roomA);
            await Promise.resolve();
          });
          expect(document.body.textContent).toContain("REVIEW B");
        },
      );
    });

    it("ignores a retired rebuild failing after the review was left", async () => {
      const roomName = "branch:late-leave-failure:gen:1";
      unavailable.mockClear();
      await withReactRoot(
        <Harness
          initial={{
            documentId: "late-leave-failure",
            reviewDraftId: "draft-left",
            reviewRoomName: roomName,
            onReviewSessionUnavailable: unavailable,
          }}
        />,
        async () => {
          await refuse(roomName);
          await act(async () => {
            applyProps({ reviewDraftId: null, reviewRoomName: null });
          });
          await act(async () => {
            failRebuild();
            await Promise.resolve();
          });
          expect(unavailable).not.toHaveBeenCalled();
        },
      );
    });

    it("reports the failure of the rebuild that is still current", async () => {
      const roomName = "branch:current-failure:gen:1";
      unavailable.mockClear();
      await withReactRoot(
        <Harness
          initial={{
            documentId: "current-failure",
            reviewDraftId: "draft-current",
            reviewRoomName: roomName,
            onReviewSessionUnavailable: unavailable,
          }}
        />,
        async () => {
          await refuse(roomName);
          await act(async () => {
            failRebuild();
            await Promise.resolve();
          });
          expect(unavailable).toHaveBeenCalledOnce();
        },
      );
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
