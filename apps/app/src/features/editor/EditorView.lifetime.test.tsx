// @vitest-environment jsdom
/** Writer edits, undo history, and read-only fencing survive editor surface changes. */

import type { Work } from "@meridian/contracts/works";
import type { Editor } from "@tiptap/core";
import { act, StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { resolveDocumentLink } from "@/client/api/document-links-api";
import type {
  DocumentSession,
  DocumentSessionConnectionState,
  DocumentSessionSnapshot,
  SchemaFence,
} from "@/core/editor/document-session";
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

const registry = {
  retain: () => {},
  release: () => {},
  getRoom: sessionFor,
  getDetached: sessionFor,
  has: () => false,
  get: sessionFor,
  retainBranchRooms: () => {},
  releaseBranchRooms: () => {},
  getBranchRoom: sessionFor,
};

const controller = {
  registerInlineReviewRuntime: () => {},
  releaseInlineReviewRuntime: () => {},
  inlineReviewModelAvailable: () => {},
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
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({ controller }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useLiveDocumentSessionRegistry: () => registry,
  useOptionalAccountResourceReplica: () => null,
  useAccountResourceProjection: () => ({
    snapshot: null,
    records: [
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
            workId: holderScheme === "scratch" || holderScheme === "uploads" ? namedWork.id : null,
            workSlug: "named",
          },
        },
        intents: [],
      },
    ],
    error: null,
  }),
}));
vi.mock("./useInlineReviewSync", () => ({ useInlineReviewSync: () => {} }));
vi.mock("./SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("./surfaces/link", () => ({
  ProjectLinkRuntime: () => {
    observedScope = useEditorScope();
    return null;
  },
}));
vi.mock("@/features/links", () => ({
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
  ])("%s links ignore the Editor route Work for resolution", async (scheme) => {
    holderScheme = scheme;
    const expectedWork = scheme === "scratch" || scheme === "uploads" ? namedWork : noWork;
    await withReactRoot(
      <Harness initial={{ documentId: "holder", projectId: "project-1", workId: namedWork.id }} />,
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
        await act(async () => applyProps({ workId: null }));
        expect(observedScope.workId).toBe(expectedWork.id);
        expect(indexedWorkId).toBe(expectedWork.id);
        expect(referenceWorkId).toBe(expectedWork.id);
      },
    );
    holderScheme = "manuscript";
  });
});
