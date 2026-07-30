/**
 * EditorView — the collaborative document editor surface.
 *
 * Binds a `DocumentSession` (Yjs `Y.Doc` + awareness + cursor provider) to a
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
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { WS_CLOSE, type YjsTrackedSchemaType } from "@meridian/contracts/protocol";
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

import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { openImagePicker } from "@/core/editor/images";
import { registerLiveRangeEditor } from "@/core/editor/live-range-navigation-runtime";
import {
  type EditorMountIdentity,
  editorMountKey,
  editorRoomKey,
  useMountedEditor,
} from "@/core/editor/mounted-editor";
import { usePrefetchTrailDetails } from "@/features/change-trail/trail-detail-query";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { cn } from "@/lib/utils";
import { EditorChromeHost } from "./chrome/EditorChromeHost";
import { EditorSurfaceFrame } from "./EditorSurfaceFrame";
import { type EditorBindHorizonResult, waitForEditorBindHorizon } from "./editor-bind-horizon";
import { editorColumnCanvas, editorColumnFill, editorProseClass } from "./editor-column";
import { type EditorScope, EditorScopeProvider } from "./editor-scope";
import { SchemaFenceNotice } from "./SchemaFenceNotice";
import { SchemaRepairNotice } from "./SchemaRepairNotice";
import { SyncStatus } from "./SyncStatus";
import { ImageIngressRuntime } from "./surfaces/images";
import { ProjectLinkRuntime, useLinkableDocuments } from "./surfaces/link";
import { documentSlashCatalog } from "./surfaces/slash";
import { DocumentToolbar } from "./surfaces/toolbar";
import { useAgentNames } from "./useAgentNames";
import { useInlineReviewSync } from "./useInlineReviewSync";
import "./editor.css";

export type EditorViewProps = {
  documentId: string;
  /** Keep a not-yet-materialized live document off server transport. */
  detached?: boolean;
  projectId?: string;
  schemaType?: YjsTrackedSchemaType;
  className?: string;
  /** Overrides TipTap editability; mobile passes false while keeping Yjs live. */
  editable?: boolean;
  /** Read-only hosts (phone) mount the manuscript without the document toolbar. */
  showToolbar?: boolean;
  /**
   * False for an editor a host keeps mounted behind the visible one. Its
   * chrome stands down: surfaces portal to the body, so a hidden ancestor
   * would not hide a menu or an object row.
   */
  active?: boolean;
  /** Accessible label override when the surface is read-only. */
  ariaLabel?: string;
  /** Remote cursor/selection decorations; mobile read-only documents hide them. */
  showCollaborationDecorations?: boolean;
  /**
   * The Work this editor is open in — the active editing context, not a review's
   * ownership. It scopes what a `[[` menu offers, what the resolver is asked, and
   * where a followed link is looked for. Runtime scope: changing it never
   * remounts the editor.
   */
  workId?: string | null;
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
function mountIdentity(props: EditorViewProps): EditorMountIdentity {
  const shared = {
    documentId: props.documentId,
    projectId: props.projectId,
    schemaType: props.schemaType ?? "document",
    collaborationDecorations: props.showCollaborationDecorations ?? true,
  } as const;
  const reviewDraftId = props.reviewDraftId;
  const reviewRoomName = props.reviewRoomName;
  if ((reviewDraftId && !reviewRoomName) || (!reviewDraftId && reviewRoomName)) {
    throw new Error("Review editor requires both reviewDraftId and reviewRoomName");
  }
  return reviewDraftId && reviewRoomName
    ? { ...shared, surface: "review", roomName: reviewRoomName, draftId: reviewDraftId }
    : { ...shared, surface: "live", detached: props.detached ?? false };
}

export function EditorView(props: EditorViewProps) {
  const identity = mountIdentity(props);
  const roomKey = editorRoomKey(identity);
  const detached = identity.surface === "live" && identity.detached;
  const inReview = identity.surface === "review";
  const [boundSession, setBoundSession] = useState<DocumentSession | null>(null);
  const sessionOwnerIdRef = useRef<string | null>(null);
  sessionOwnerIdRef.current ??= `editor-view:${++editorSessionOwnerSequence}`;

  useEffect(() => {
    // The app-level registry owns teardown. This view only contributes the room
    // it is currently bound to so short-lived draft sessions are reclaimed when
    // inline review exits.
    const registry = getDocumentSessionRegistry();
    const ownerId = sessionOwnerIdRef.current;
    if (!ownerId) return;
    registry.retain(ownerId, [roomKey], {
      detachedRoomKeys: detached ? [roomKey] : [],
    });
    const session = detached ? registry.getDetached(roomKey) : registry.getRoom(roomKey);
    setBoundSession(session);
    return () => registry.release(ownerId);
  }, [detached, roomKey]);

  useEffect(() => {
    if (!inReview || boundSession?.roomKey !== roomKey) return;
    return boundSession.subscribe((snapshot) => {
      if (
        snapshot.status === "destroyed" ||
        snapshot.connectionState?.kind === "terminal" ||
        snapshot.connectionState?.kind === "unauthorized" ||
        snapshot.connectionState?.kind === "reset"
      ) {
        props.onReviewSessionUnavailable?.();
      }
    });
  }, [boundSession, props.onReviewSessionUnavailable, inReview, roomKey]);

  const session = boundSession?.roomKey === roomKey ? boundSession : null;

  if (!session) return <PendingEditorShell {...props} />;

  // The one place an editor's lifetime is decided. Every input the session
  // lookup above reads is part of this key, so a session swap always arrives
  // with a fresh mount and nothing else can force one.
  return (
    <SessionEditorView
      key={editorMountKey(identity)}
      {...props}
      identity={identity}
      session={session}
    />
  );
}

type SessionEditorViewProps = EditorViewProps & {
  identity: EditorMountIdentity;
  session: DocumentSession;
};

function SessionEditorView(props: SessionEditorViewProps) {
  const [snapshot, setSnapshot] = useState(() => props.session.getSnapshot());
  const [bindHorizon, setBindHorizon] = useState<EditorBindHorizonResult | null>(null);
  const requiresFirstServerSync = !(props.identity.surface === "live" && props.identity.detached);

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
  active = true,
  ariaLabel,
  workId = null,
  reviewWorkId = null,
  onReviewSessionUnavailable,
  session,
  snapshot,
  evidenceDegraded,
}: ActiveSessionEditorViewProps) {
  const { documentId, projectId } = identity;
  const { controller } = useDraftReview();
  const inReview = identity.surface === "review";
  const reviewDraftId = identity.surface === "review" ? identity.draftId : null;
  const registry = getDocumentSessionRegistry();
  const liveReviewSession = inReview && registry.has(documentId) ? registry.get(documentId) : null;
  const editorRef = useRef<Editor | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const effectiveEditableRef = useRef(true);
  const agentNames = useAgentNames(projectId, { enabled: !inReview });
  const effectiveEditable = editable && !snapshot.schemaFence;
  effectiveEditableRef.current = effectiveEditable;

  // Which project and which Work this editor is open in. Everything that has to
  // reach past the document — the `[[` candidates, the resolver, a followed
  // link — reads this one value, and none of it is a reason to remount.
  const scope = useMemo<EditorScope>(
    () => ({ projectId: projectId ?? null, workId }),
    [projectId, workId],
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
    return documentSlashCatalog(() => openImagePicker(editorRef.current));
  }, [effectiveEditable, identity.schemaType]);

  // Read when the `[[` menu opens, for the same reason as the slash catalog:
  // the label resolves against whatever locale is active then, and the document
  // list changes every time the writer creates or renames a file.
  const wikilinkDocuments = useLinkableDocuments(scope);
  const wikilinkCatalog = useCallback(() => {
    if (identity.schemaType !== "document" || !effectiveEditable || !projectId) return null;
    return { label: t`Link a document`, documents: wikilinkDocuments };
  }, [effectiveEditable, identity.schemaType, projectId, wikilinkDocuments]);

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
    wikilinkCatalog,
    surface: { editable: effectiveEditable, editorProps },
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
    if (!editor || inReview) return;
    return registerLiveRangeEditor(documentId, editor);
  }, [documentId, editor, inReview]);

  useEffect(
    () => () => {
      editorRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      const scroller = scrollContainerRef.current;
      if (scroller?.scrollTop !== 0) return;
      const savedTop = Number(scroller.dataset.stableLayoutScrollTop ?? 0);
      if (savedTop > 0) scroller.scrollTop = savedTop;
    }, 250);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <EditorScopeProvider projectId={scope.projectId} workId={scope.workId}>
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
                onUploadFigure={() => openImagePicker(editor)}
                uploadAvailable={Boolean(projectId)}
              />
            ) : undefined
          }
          scrollRef={scrollContainerRef}
          onScroll={(event) => {
            event.currentTarget.dataset.stableLayoutScrollTop = String(
              event.currentTarget.scrollTop,
            );
            event.currentTarget.dataset.stableLayoutScrollLeft = String(
              event.currentTarget.scrollLeft,
            );
          }}
        />
        {/* The one chrome mount host. Every surface registers in
          `chrome/chrome-surfaces.tsx`; nothing new is added to this file. */}
        <EditorChromeHost editor={editor} active={active} />
        {/* Where an internal link goes, and where a picture's bytes go. Ports, not
          surfaces: each renders nothing, and what a writer sees from either lane
          mounts through the host above. */}
        <ProjectLinkRuntime editor={editor} documentId={documentId} />
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
      scrollClassName="meridian-editor main-pane relative"
      onScroll={onScroll}
    >
      <div className={cn(editorColumnCanvas, editorColumnFill)}>
        <EditorContent editor={editor} className={editorColumnFill} />
      </div>
    </EditorSurfaceFrame>
  );
}
