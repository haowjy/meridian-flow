/**
 * EditorView — the collaborative document editor surface.
 *
 * Binds a `DocumentSession` (Yjs `Y.Doc` + this client's presence) to a
 * TipTap/ProseMirror editor and renders the surrounding chrome (document
 * toolbar, sync-status indicator, chrome host). Whole concerns live in their own
 * modules and reach the editor through it: images arrive through
 * `core/editor/images` and its runtime, links through the link lane.
 * Used by the Context screen to open any document. Filename chrome is the
 * host's job (desktop tab strip / phone top-bar breadcrumb), so this view
 * renders no title header of its own.
 *
 * Props split in two: those that form the `EditorMountIdentity` decide which
 * editor exists (they key the mount), and the rest are surface config applied
 * to whatever editor is already running.
 *
 * The room's access scope is surface config too: a room the server makes
 * read-only (an archived Work's draft or scratch) stops taking edits in place,
 * with no remount. Only a review room whose pending edits the server refused
 * is rebuilt, from the server's state.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseContextUri } from "@meridian/contracts";
import { WS_CLOSE, type YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import { projectResourceLocation, resourceForDocumentIdentity } from "@meridian/resource-replica";
import type { Editor, EditorOptions } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import {
  type ReactNode,
  type Ref,
  type UIEventHandler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useWorks } from "@/client/query/useWorks";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import { imageCaretTarget, openImagePicker } from "@/core/editor/images";
import { isLinkDocumentScheme, linkAheadAddress } from "@/core/editor/links";
import { registerLiveRangeEditor } from "@/core/editor/live-range-navigation-runtime";
import {
  type EditorMountIdentity,
  editorMountKey,
  editorRoomKey,
  useMountedEditor,
} from "@/core/editor/mounted-editor";
import { useReadingPosition } from "@/core/editor/use-reading-position";
import { usePrefetchTrailDetails } from "@/features/change-trail/trail-detail-query";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { useLinkableDocuments } from "@/features/links";
import {
  useAccountEpochSignal,
  useAccountId,
  useAccountResourceProjection,
  useLiveDocumentSessionRegistry,
} from "@/features/project/context/account-feature-context";
import { cn } from "@/lib/utils";
import { EditorChromeHost } from "./chrome/EditorChromeHost";
import { EditorSurfaceFrame } from "./EditorSurfaceFrame";
import { type EditorBindHorizonResult, waitForEditorBindHorizon } from "./editor-bind-horizon";
import { editorColumnCanvas, editorColumnFill, editorProseClass } from "./editor-column";
import { type EditorScope, EditorScopeProvider } from "./editor-scope";
import { captureReview, FrozenReview, type FrozenReviewMarkup } from "./FrozenReview";
import { useReferenceBrowserCatalog } from "./references/useReferenceBrowserCatalog";
import { SchemaFenceNotice } from "./SchemaFenceNotice";
import { SchemaRepairNotice } from "./SchemaRepairNotice";
import { SyncStatus } from "./SyncStatus";
import { ImageIngressRuntime } from "./surfaces/images";
import { ProjectLinkRuntime } from "./surfaces/link";
import { documentSlashCatalog } from "./surfaces/slash";
import { DocumentToolbar } from "./surfaces/toolbar";
import { useAgentNames } from "./useAgentNames";
import { useInlineReviewSync } from "./useInlineReviewSync";
import "./editor.css";

export type EditorViewProps = {
  documentId: string;
  /** Exact host-owned live/local session. Omitted only for branch review until F1-I3. */
  session?: DocumentSession;
  /** Stable editor lifetime across local identity remint/materialization. */
  bindingKey?: string;
  /** Keep a not-yet-materialized live document off server transport. */
  detached?: boolean;
  /** The host already opened and verified exact local content for this session. */
  localContentReady?: boolean;
  projectId?: string;
  schemaType?: YjsTrackedSchemaType;
  className?: string;
  /** Overrides TipTap editability; mobile passes false while keeping Yjs live. */
  editable?: boolean;
  /** Read-only hosts (phone) mount the manuscript without the document toolbar. */
  showToolbar?: boolean;
  /**
   * False for an editor a host keeps mounted behind the visible one. Its
   * chrome stands down: a menu, a dialog, and a suggestion list all portal to
   * the body, where a hidden ancestor cannot reach them.
   */
  active?: boolean;
  /** Accessible label override when the surface is read-only. */
  ariaLabel?: string;
  /** Remote cursor/selection decorations; mobile read-only documents hide them. */
  showCollaborationDecorations?: boolean;
  /** Active draft room for inline review; absent means bind to the live document room. */
  reviewDraftId?: string | null;
  /** Generation-fenced room name for the active branch review room, supplied by the preview DTO. */
  reviewRoomName?: string | null;
  /** Work that owns the draft review — required to query the hunk model when reviewing. */
  reviewWorkId?: string | null;
  /** Called when the active draft session becomes terminal/unavailable. */
  onReviewSessionUnavailable?: () => void;
};

let editorSessionOwnerSequence = 0;

/**
 * Which editor this props set asks for. Inline review needs both a draft id and
 * the generation-fenced room it lives in; a draft id alone is a host that has
 * not resolved the room yet, and review decorations must never be projected
 * onto the live manuscript room.
 */
function mountIdentity(props: EditorViewProps, surface: "live" | "review"): EditorMountIdentity {
  const shared = {
    documentId: props.documentId,
    projectId: props.projectId,
    schemaType: props.schemaType ?? "document",
    collaborationDecorations: props.showCollaborationDecorations ?? true,
  } as const;
  const reviewDraftId = props.reviewDraftId;
  const reviewRoomName = props.reviewRoomName;
  if (!reviewDraftId && reviewRoomName) {
    throw new Error("Review editor requires a reviewDraftId with its reviewRoomName");
  }
  return surface === "review" && reviewDraftId && reviewRoomName
    ? // A branch room is its own session: the live binding's identity (which a
      // rename can re-mint) must not rebuild the review.
      { ...shared, surface: "review", roomName: reviewRoomName, draftId: reviewDraftId }
    : {
        ...shared,
        bindingKey: props.bindingKey,
        surface: "live",
        detached: props.detached ?? false,
      };
}

export function EditorView(props: EditorViewProps) {
  const identity = mountIdentity(props, "review");
  const roomKey = editorRoomKey(identity);
  const inReview = identity.surface === "review";
  // Review is intended from the click, before its room resolves or paints. Until
  // the branch editor owns input, the live manuscript stays painted but read-only.
  const reviewRequested = Boolean(props.reviewDraftId);
  const registry = useLiveDocumentSessionRegistry();
  const [boundSession, setBoundSession] = useState<DocumentSession | null>(null);
  // The review mount whose editor exists. Until then the live editor stays on
  // screen, so entering review never shows an empty body.
  const [paintedReviewKey, setPaintedReviewKey] = useState<string | null>(null);
  // The painted review while its refused room is rebuilt: an inert copy, so neither the
  // live prose nor an empty shell shows under a review the writer is still in. It belongs to
  // the one review identity (document, room, draft) it was copied from and renders for no other.
  const reviewIdentity = inReview ? editorMountKey(identity) : null;
  const [replaced, setReplaced] = useState<{
    identity: string;
    markup: FrozenReviewMarkup;
  } | null>(null);
  const replacedReview = replaced && replaced.identity === reviewIdentity ? replaced.markup : null;
  // The rebuild in flight for the current review identity. Leaving or changing the review
  // retires it, so a late completion or failure can neither bind nor report for another review.
  const rebuildAttemptRef = useRef<symbol | null>(null);
  const reviewHostRef = useRef<HTMLDivElement | null>(null);
  const reviewPaintedRef = useRef(false);
  const sessionOwnerIdRef = useRef<string | null>(null);
  sessionOwnerIdRef.current ??= `editor-view:${++editorSessionOwnerSequence}`;

  useEffect(() => {
    if (!inReview) {
      setBoundSession(null);
      setPaintedReviewKey(null);
      setReplaced(null);
      return;
    }
    const ownerId = sessionOwnerIdRef.current;
    if (!ownerId) return;
    registry.retainBranchRooms(ownerId, [roomKey]);
    let session: DocumentSession;
    try {
      session = registry.getBranchRoom(roomKey);
    } catch (error) {
      registry.releaseBranchRooms(ownerId);
      throw error;
    }
    setBoundSession(session);
    return () => {
      rebuildAttemptRef.current = null;
      setReplaced(null);
      registry.releaseBranchRooms(ownerId);
    };
  }, [inReview, registry, roomKey]);

  useEffect(() => {
    if (!inReview || boundSession?.roomKey !== roomKey) return;
    let rebuilding = false;
    return boundSession.subscribe((snapshot) => {
      if (rebuilding) return;
      if (boundSession.refusedLocalEdits()) {
        // Only the refused characters are lost: the review stays open on a
        // fresh session synced from the server.
        rebuilding = true;
        // Hold what is painted, then unbind before the retired session's Y.Doc is destroyed
        // under the editor. A replacement still waiting to paint keeps the copy already held.
        if (reviewPaintedRef.current) {
          const held = captureReview(reviewHostRef.current);
          if (held && reviewIdentity) setReplaced({ identity: reviewIdentity, markup: held });
        }
        setBoundSession(null);
        const attempt = Symbol("review-rebuild");
        rebuildAttemptRef.current = attempt;
        void registry.rebuildBranchRoom(roomKey).then(
          (rebuilt) => {
            if (rebuildAttemptRef.current === attempt) setBoundSession(rebuilt);
          },
          () => {
            if (rebuildAttemptRef.current !== attempt) return;
            setReplaced(null);
            props.onReviewSessionUnavailable?.();
          },
        );
        return;
      }
      if (
        snapshot.status === "destroyed" ||
        snapshot.connectionState?.kind === "terminal" ||
        snapshot.connectionState?.kind === "unauthorized" ||
        snapshot.connectionState?.kind === "reset"
      ) {
        props.onReviewSessionUnavailable?.();
      }
    });
  }, [boundSession, props.onReviewSessionUnavailable, inReview, registry, roomKey, reviewIdentity]);

  const liveSession = props.session ?? null;
  const reviewSession = inReview && boundSession?.roomKey === roomKey ? boundSession : null;
  const reviewKey =
    inReview && reviewSession ? `${editorMountKey(identity)}|${reviewSession.document.guid}` : null;
  const reviewVisible = reviewSession !== null && paintedReviewKey === reviewKey;
  reviewPaintedRef.current = reviewVisible;
  // Until the replacement paints, the copy stands in for the review it replaces.
  const replacing = inReview && !reviewVisible && replacedReview !== null;
  // With no live editor underneath, the branch's own shell (or notice) is all
  // there is to see, so it shows from its first render.
  const reviewShown = reviewVisible || (!liveSession && !replacing);

  useEffect(() => {
    if (reviewVisible) setReplaced(null);
  }, [reviewVisible]);

  if (!liveSession && !reviewSession && !replacing) return <PendingEditorShell {...props} />;

  // The one place an editor's lifetime is decided. Every input a session lookup
  // reads is part of its key, so a session swap always arrives with a fresh
  // mount and nothing else can force one. A rebuilt or reopened room keeps its
  // name, so the session's own Y.Doc is part of the key. A document's live
  // editor stays mounted, hidden, underneath its review: Apply, Discard and
  // Back to live then reveal the warm editor instead of rebuilding one.
  return (
    <>
      {liveSession ? (
        <div className={reviewVisible || replacing ? "hidden" : "contents"}>
          <SessionEditorView
            key={`${editorMountKey(mountIdentity(props, "live"))}|${liveSession.document.guid}`}
            {...props}
            editable={reviewRequested ? false : props.editable}
            identity={mountIdentity(props, "live")}
            session={liveSession}
            liveSession={liveSession}
            held={reviewRequested}
          />
        </div>
      ) : null}
      {replacing && replacedReview ? <FrozenReview markup={replacedReview} /> : null}
      {reviewSession && reviewKey ? (
        <div ref={reviewHostRef} className={reviewShown ? "contents" : "hidden"}>
          <SessionEditorView
            key={reviewKey}
            {...props}
            identity={identity}
            session={reviewSession}
            liveSession={liveSession}
            onPainted={() => setPaintedReviewKey(reviewKey)}
          />
        </div>
      ) : null}
    </>
  );
}

type SessionEditorViewProps = EditorViewProps & {
  identity: EditorMountIdentity;
  session: DocumentSession;
  liveSession: DocumentSession | null;
  /** The live editor kept warm under an active review: its chrome and navigation stand down. */
  held?: boolean;
  /** Called once this mount's TipTap editor exists and is showing its content. */
  onPainted?: () => void;
};

function SessionEditorView(props: SessionEditorViewProps) {
  const [snapshot, setSnapshot] = useState(() => props.session.getSnapshot());
  const [bindHorizon, setBindHorizon] = useState<EditorBindHorizonResult | null>(null);
  const requiresFirstServerSync = !(
    props.identity.surface === "live" &&
    (props.identity.detached || props.localContentReady)
  );

  useEffect(() => props.session.subscribe(setSnapshot), [props.session]);
  useEffect(() => {
    let active = true;
    const firstServerSync = requiresFirstServerSync ? props.session.whenSynced() : undefined;
    void waitForEditorBindHorizon({
      localPersistence: props.session.whenLocalPersistenceSynced(),
      firstServerSync,
    }).then((result) => {
      if (active) setBindHorizon(result);
    });
    return () => {
      active = false;
    };
  }, [props.session, requiresFirstServerSync]);

  if (
    snapshot.connectionState?.kind === "reset" &&
    snapshot.connectionState.reason === WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason
  ) {
    return (
      <p data-document-schema-stale>
        <Trans>This chapter is temporarily unavailable</Trans>
      </p>
    );
  }

  if (!bindHorizon) return <PendingEditorShell {...props} />;

  return (
    <ActiveSessionEditorView
      {...props}
      snapshot={snapshot}
      evidenceDegraded={bindHorizon.evidenceDegraded}
    />
  );
}

type ActiveSessionEditorViewProps = SessionEditorViewProps & {
  snapshot: DocumentSessionSnapshot;
  evidenceDegraded: boolean;
};

function ActiveSessionEditorView({
  identity,
  className,
  editable = true,
  showToolbar = true,
  active: hostActive = true,
  ariaLabel,
  reviewWorkId = null,
  onReviewSessionUnavailable,
  session,
  liveSession,
  held = false,
  onPainted,
  snapshot,
  evidenceDegraded,
}: ActiveSessionEditorViewProps) {
  const active = hostActive && !held;
  const accountId = useAccountId();
  const accountEpoch = useAccountEpochSignal();
  const { documentId, projectId } = identity;
  const { controller } = useDraftReview();
  const inReview = identity.surface === "review";
  const reviewDraftId = identity.surface === "review" ? identity.draftId : null;
  const liveReviewSession = inReview ? liveSession : null;
  const editorRef = useRef<Editor | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const effectiveEditableRef = useRef(true);
  const agentNames = useAgentNames(projectId, { enabled: !inReview });
  const effectiveEditable = editable && !snapshot.schemaFence && snapshot.access !== "read";
  effectiveEditableRef.current = effectiveEditable;

  // Links belong to their holder, never to the route's or a chat's Work.
  const { records } = useAccountResourceProjection(projectId ?? "");
  const { noWork } = useWorks(projectId ?? "", { enabled: Boolean(projectId) });
  const holder = resourceForDocumentIdentity(records, documentId);
  const location = holder && projectId ? projectResourceLocation(projectId, holder) : null;
  // A draft-created document has no holder record until Apply, so under review
  // its links belong to the draft's Work. Without one the scope would stay
  // pending and a followed link would wait forever.
  // A note in a chat's Scratch has no Work; it links as No Work and names its lineage.
  const linkRootThreadId = location?.rootThreadId ?? null;
  const linkWorkId = !location
    ? reviewWorkId
    : linkRootThreadId
      ? (noWork?.id ?? null)
      : location.scheme === "scratch" || location.scheme === "uploads"
        ? location.workId
        : (noWork?.id ?? null);
  const scope = useMemo<EditorScope>(
    () => ({ projectId: projectId ?? null, workId: linkWorkId, rootThreadId: linkRootThreadId }),
    [projectId, linkWorkId, linkRootThreadId],
  );

  // Marks render before anyone clicks one. Warming their trail detail here is
  // what lets the popover open with its Before/After disclosure already
  // available instead of filling it in after the first fetch lands.
  const markers = useSyncExternalStore(
    session.markerStore.subscribe,
    session.markerStore.getSnapshot,
    session.markerStore.getSnapshot,
  );
  usePrefetchTrailDetails(
    useMemo(
      () =>
        inReview
          ? []
          : markers.flatMap((marker) =>
              marker.author.kind === "agent" && !marker.dismissed
                ? [{ threadId: marker.author.threadId, trailId: marker.group.trailId }]
                : [],
            ),
      [inReview, markers],
    ),
  );

  // A fence has to withdraw the catalog, not just the surface's editability:
  // slash commands dispatch through TipTap chains, which run on a non-editable
  // editor, so a menu already open when the fence lands would still insert.
  const slashCommandCatalog = useCallback(() => {
    if (identity.schemaType !== "document" || !effectiveEditable) return null;
    // The place the pick was made, not the caret when the file comes back: the
    // chooser outlives both the writer's own caret and every peer's writes.
    return documentSlashCatalog((at) => openImagePicker(editorRef.current, { kind: "insert", at }));
  }, [effectiveEditable, identity.schemaType]);

  // The scope's document index: what this document's relative links resolve
  // against, and which addresses already hold a document.
  const linkableDocuments = useLinkableDocuments(
    active ? scope : { projectId: null, workId: null },
  );
  // This document's own address: what its relative links resolve against and
  // what a link inserted into it is spelled relative to. Null until the tree
  // carrying it arrives, or while it has no address yet, which spells full URIs.
  const holderUri = useMemo(
    () =>
      linkableDocuments.documents.find((document) => document.documentId === documentId)?.uri ??
      null,
    [linkableDocuments, documentId],
  );
  const sharedReferenceCatalog = useReferenceBrowserCatalog(
    active ? projectId : null,
    active ? scope.workId : null,
    t`Reference a file`,
    active ? scope.rootThreadId : null,
  );
  // Where a link to a document nobody has written goes, unless a document is
  // already there: the `@` menu's link-ahead row, and a pasted `[[Name]]` that
  // names nothing (with folders, for a path link). Dashed until a follow's
  // Create makes the document.
  const occupied = useMemo(
    () => new Set(linkableDocuments.documents.map((document) => document.uri)),
    [linkableDocuments],
  );
  const linkAhead = useCallback(
    (name: string, folders?: readonly string[]) => {
      const uri = linkAheadAddress(holderUri, name, folders);
      return uri && !occupied.has(uri) ? { uri } : null;
    },
    [holderUri, occupied],
  );
  // Read when the `@` menu opens.
  const atReferenceCatalog = useCallback(() => {
    if (identity.schemaType !== "document" || !effectiveEditable || !sharedReferenceCatalog)
      return null;
    return { ...sharedReferenceCatalog, linkAhead: (name: string) => linkAhead(name) };
  }, [effectiveEditable, identity.schemaType, linkAhead, sharedReferenceCatalog]);
  // What a pasted `[[Name]]` may name: the Editor's link index (the same one
  // its links resolve against and link-ahead checks), in Manuscript, KB, User,
  // Unfiled and this Work's Scratch. Uploads hold files rather than documents.
  const pasteTargets = useMemo(
    () =>
      linkableDocuments.documents.flatMap((document) => {
        const parsed = parseContextUri(document.uri);
        return parsed.ok && isLinkDocumentScheme(parsed.value.scheme)
          ? [{ documentId: document.documentId, uri: document.uri }]
          : [];
      }),
    [linkableDocuments],
  );
  // Read at paste time. An index still loading converts nothing, rather than
  // turning every link dashed.
  const wikilinkPasteCatalog = useCallback(
    () =>
      identity.schemaType === "document" && linkableDocuments.complete
        ? { holderUri, targets: pasteTargets, linkAhead }
        : null,
    [holderUri, identity.schemaType, linkAhead, linkableDocuments.complete, pasteTargets],
  );

  // Surface config: applied to the running editor, never a reason to rebuild it.
  // Only the prose node's own attributes live here; a lane that answers a press
  // does it in its own extension, where the state it reads already is.
  const editorProps = useMemo<NonNullable<EditorOptions["editorProps"]>>(
    () => ({
      attributes: {
        class: editorProseClass(showToolbar ? "docked" : "none"),
        "aria-label": ariaLabel ?? t`Collaborative document editor`,
      },
    }),
    [ariaLabel, showToolbar],
  );

  const editor = useMountedEditor({
    identity,
    session,
    agentNames,
    placeholder: t`Start writing…`,
    slashCommandCatalog,
    atReferenceCatalog,
    wikilinkPasteCatalog,
    surface: { editable: effectiveEditable, editorProps, publishPresence: active },
    evidenceDegraded,
  });

  // Claim the shared review-runtime slot ONLY while this editor is the one in
  // review. Editors that are not in review must not touch the slot at all: the
  // context host keeps warm hidden editors mounted, and an unconditional clear
  // from any of them stomps the active editor's claim (dock card clicks then
  // silently no-op). Release is claim-checked controller-side.
  //
  // Depend on the STABLE register/release callbacks, never the whole controller
  // object: the controller's identity changes on every review state change, so
  // depending on it would release + re-register the slot on each render and open
  // a transient "no runtime" window where card focus/scroll/discard no-ops.
  const { registerInlineReviewRuntime, releaseInlineReviewRuntime } = controller;
  useEffect(() => {
    if (!reviewDraftId || !editor) return;
    registerInlineReviewRuntime({
      editor,
      documentId,
      draftId: reviewDraftId,
    });
    return () => releaseInlineReviewRuntime(editor);
  }, [registerInlineReviewRuntime, releaseInlineReviewRuntime, documentId, editor, reviewDraftId]);

  useInlineReviewSync({
    editor,
    liveSession: liveReviewSession,
    projectId: projectId ?? null,
    workId: reviewWorkId,
    documentId,
    draftId: reviewDraftId,
    enabled: inReview,
    onInlineModelAvailable: controller.inlineReviewModelAvailable,
    onReviewSessionUnavailable,
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor || inReview || held) return;
    return registerLiveRangeEditor(documentId, editor);
  }, [documentId, editor, inReview, held]);

  useEffect(() => {
    if (editor) onPainted?.();
  }, [editor, onPainted]);

  useEffect(
    () => () => {
      editorRef.current = null;
    },
    [],
  );

  useReadingPosition({
    editor,
    pane: scrollContainerRef,
    accountId,
    documentId,
    active,
    review: inReview || held,
    signal: accountEpoch,
  });

  return (
    <EditorScopeProvider
      projectId={scope.projectId}
      workId={scope.workId}
      rootThreadId={scope.rootThreadId}
    >
      <section
        className={cn(
          "meridian-editor-shell relative flex h-full min-h-0 flex-col bg-background",
          className,
        )}
      >
        {/* Sync is assumed-healthy, so it floats quietly and only appears when
          there is something to act on (offline / closed) — see SyncStatus. */}
        {session ? (
          <div className="pointer-events-none absolute right-3 bottom-3 z-10">
            <SyncStatus session={session} />
          </div>
        ) : null}
        {snapshot.schemaFence ? <SchemaFenceNotice fence={snapshot.schemaFence} /> : null}
        {snapshot.schemaRepairs.length > 0 ? (
          <SchemaRepairNotice repairs={snapshot.schemaRepairs} />
        ) : null}
        <TrackedEditorCanvas
          editor={editor}
          toolbar={
            showToolbar ? (
              <DocumentToolbar
                editor={editor}
                editable={effectiveEditable}
                schemaType={identity.schemaType}
                onUploadFigure={() => openImagePicker(editor, imageCaretTarget(editor))}
                uploadAvailable={Boolean(projectId)}
              />
            ) : undefined
          }
          scrollRef={scrollContainerRef}
        />
        {/* The one chrome mount host. Every surface registers in
          `chrome/chrome-surfaces.tsx`; nothing new is added to this file. */}
        <EditorChromeHost editor={editor} active={active} />
        {/* Where an internal link goes, and where a picture's bytes go. Ports, not
          surfaces: each renders nothing, and what a writer sees from either lane
          mounts through the host above. */}
        <ProjectLinkRuntime
          editor={editor}
          documentId={documentId}
          baseUri={holderUri}
          index={linkableDocuments}
          active={active}
        />
        <ImageIngressRuntime editor={editor} projectId={projectId} documentId={documentId} />
      </section>
    </EditorScopeProvider>
  );
}

function PendingEditorShell({ className, showToolbar = true }: EditorViewProps) {
  return (
    <section
      className={cn(
        "meridian-editor-shell relative flex h-full min-h-0 flex-col bg-background",
        className,
      )}
    >
      {/* The toolbar is persistent chrome: it holds its place while the
          document opens, greyed and saying so, rather than popping in. */}
      <TrackedEditorCanvas
        editor={null}
        toolbar={showToolbar ? <DocumentToolbar editor={null} /> : undefined}
      />
    </section>
  );
}

function TrackedEditorCanvas({
  editor,
  toolbar,
  scrollRef,
  onScroll,
}: {
  editor: Editor | null;
  toolbar?: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}) {
  return (
    <EditorSurfaceFrame
      toolbar={toolbar}
      editor={editor}
      scrollRef={scrollRef}
      scrollClassName="meridian-editor main-pane"
      onScroll={onScroll}
    >
      <div className={cn(editorColumnCanvas, editorColumnFill)}>
        <EditorContent editor={editor} className={editorColumnFill} />
      </div>
    </EditorSurfaceFrame>
  );
}
