// @vitest-environment jsdom
/** Writer edits, undo history, and read-only fencing survive editor surface changes. */

import type { Work } from "@meridian/contracts/works";
import type { Editor } from "@tiptap/core";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type {
  DocumentSession,
  DocumentSessionConnectionState,
  DocumentSessionSnapshot,
  SchemaFence,
} from "@/core/editor/document-session";
import { createLocalPresence } from "@/core/editor/local-presence";
import type { SchemaRepairEvent } from "@/core/editor/schema-repair-witness";
import { SessionMarkerStore } from "@/core/editor/session-marker-store";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { EditorViewProps } from "./EditorView";
import { type EditorScope, useEditorScope } from "./editor-scope";

const noWork = { id: "no-work", slug: null, archivedAt: null } as Work;
const namedWork = { id: "named-work", slug: "named", archivedAt: null } as Work;
const holderScheme = "manuscript";
const holderProjectionReady = true;
let _observedScope: EditorScope;
let _indexedWorkId: string | null;
let _referenceWorkId: string | null;
vi.mock("./references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: (_projectId: string, workId: string | null) => {
    _referenceWorkId = workId;
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
vi.mock("./SyncStatus", () => ({ SyncStatus: () => null }));
// The real runtime and follower, with only the scope it reads observed.
vi.mock("./surfaces/link", async () => {
  const { ProjectLinkRuntime: Runtime } = await import("./surfaces/link/ProjectLinkRuntime");
  return {
    ProjectLinkRuntime: (props: React.ComponentProps<typeof Runtime>) => {
      _observedScope = useEditorScope();
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
    _indexedWorkId = scope.workId;
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
