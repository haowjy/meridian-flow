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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useWorks } from "@/client/query/useWorks";
import { PaintCapture, PaintScope, usePaintPending } from "@/components/app/PaintHold";
import { Button } from "@/components/ui/button";
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
import { usePrefetchTrailDetails } from "@/features/change-trail/trail-detail-query";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { useLinkableDocuments } from "@/features/links";
import { useAccountResourceProjection } from "@/features/project/context/account-feature-context";
import { cn } from "@/lib/utils";
import { EditorChromeHost } from "./chrome/EditorChromeHost";
import { EditorSurfaceFrame } from "./EditorSurfaceFrame";
import { type EditorBindHorizonResult, waitForEditorBindHorizon } from "./editor-bind-horizon";
import { editorColumnCanvas, editorColumnFill, editorProseClass } from "./editor-column";
import { type EditorScope, EditorScopeProvider } from "./editor-scope";
import { useReferenceBrowserCatalog } from "./references/useReferenceBrowserCatalog";
import { SchemaFenceNotice } from "./SchemaFenceNotice";
import { SchemaRepairNotice } from "./SchemaRepairNotice";
import { SyncStatus } from "./SyncStatus";
import { ImageIngressRuntime } from "./surfaces/images";
import { ProjectLinkRuntime } from "./surfaces/link";
import { documentSlashCatalog } from "./surfaces/slash";
import { DocumentToolbar } from "./surfaces/toolbar";
import { useAgentNames } from "./useAgentNames";
import { useInlineReviewFocus } from "./useInlineReviewFocus";
import { useInlineReviewSync } from "./useInlineReviewSync";
import "./editor.css";

export type EditorViewProps = {
  documentId: string;
  draftOnly?: boolean;
  onCloseDraftOnly?: () => void;
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
};

/**
 * How long a painted review editor waits for its change marks before showing
 * anyway. The preview is normally already cached from opening the room, so this
 * only bounds a preview that never arrives; the writer is never stranded on
 * read-only live text.
 */
const REVIEW_MARKS_WAIT_MS = 1500;

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
  // A requested review is the destination before its room resolves or paints.
  const reviewRequested = Boolean(props.reviewDraftId);

  // Marks and editor construction jointly decide when the review paints.
  const [paintedReviewKey, setPaintedReviewKey] = useState<string | null>(null);
  const { controller, roomOwner } = useDraftReview();
  const reviewDraftId = identity.surface === "review" ? identity.draftId : null;
  const liveSession = props.session ?? null;
  // The writer handled the last change. A Discard leaves live as it is, so the
  // finished text is already the live editor: shown in place of the review's at
  // the click, but inert, because nothing is known yet. The server's `draftClosed`
  // answer then makes it editable (the draft's text is the live text and its
  // room a dead generation; the review chrome stays, saying so). An answer that
  // did not close the draft withdraws it and the review comes back. A last Apply
  // keeps the review's editor, marks gone, until that answer: live has no change
  // in it before.
  const completion =
    controller.inlineReview?.documentId === props.documentId &&
    controller.inlineReview.draftId === reviewDraftId
      ? controller.inlineReview.completion
      : undefined;
  const closed = completion?.phase === "closed";
  const settled =
    inReview &&
    liveSession !== null &&
    (closed || (completion?.phase === "pending" && completion.mode === "discard"));
  const marksReady =
    reviewDraftId !== null &&
    controller.inlineReview?.documentId === props.documentId &&
    controller.inlineReview.draftId === reviewDraftId &&
    controller.inlineReview.previewIdentity !== undefined;
  const [marksWaitOverFor, setMarksWaitOverFor] = useState<string | null>(null);
  const reviewSession =
    inReview && !settled && roomOwner.session?.roomKey === roomKey ? roomOwner.session : null;
  const reviewKey =
    inReview && reviewSession ? `${editorMountKey(identity)}|${reviewSession.document.guid}` : null;
  const reviewPainted = reviewSession !== null && paintedReviewKey === reviewKey;
  // The editor existing is not enough: the review shows with its marks, in one
  // frame, so the writer never sees the draft text unmarked.
  const reviewVisible = reviewPainted && (marksReady || marksWaitOverFor === reviewKey);
  useEffect(() => {
    if (!reviewPainted || marksReady || !reviewKey) return;
    const timer = window.setTimeout(() => setMarksWaitOverFor(reviewKey), REVIEW_MARKS_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [reviewPainted, marksReady, reviewKey]);

  // Review chrome (the header, the chip swap) shows with the review body and
  // never before it. A layout effect, so the controller's update lands before
  // paint, in the same frame as the body swap above.
  const chromeShown = inReview && (reviewVisible || settled);
  const { setInlineReviewShown } = controller;
  useLayoutEffect(() => {
    if (!reviewDraftId) return;
    setInlineReviewShown(props.documentId, reviewDraftId, chromeShown);
  }, [setInlineReviewShown, props.documentId, reviewDraftId, chromeShown]);

  const [reviewSnapshot, setReviewSnapshot] = useState<{
    session: DocumentSession | null;
    snapshot: DocumentSessionSnapshot | null;
  }>({ session: null, snapshot: null });
  useLayoutEffect(
    () =>
      reviewSession?.subscribe((snapshot) =>
        setReviewSnapshot({ session: reviewSession, snapshot }),
      ),
    [reviewSession],
  );
  const snapshot =
    reviewSnapshot.session === reviewSession
      ? reviewSnapshot.snapshot
      : reviewSession?.getSnapshot();
  const schemaStale =
    snapshot?.connectionState?.kind === "reset" &&
    snapshot.connectionState.reason === WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason;
  const failed =
    controller.inlineReview?.documentId === props.documentId &&
    controller.inlineReview.draftId === props.reviewDraftId &&
    controller.reviewRoomError;
  const terminal = failed || schemaStale || (props.draftOnly && !reviewRequested);
  const liveKey = liveSession
    ? `${editorMountKey(mountIdentity(props, "live"))}|${liveSession.document.guid}`
    : "";
  const surface = terminal
    ? "review-error"
    : settled
      ? `live:${liveKey}`
      : reviewVisible
        ? `review:${reviewKey}`
        : reviewRequested || !liveSession
          ? "pending"
          : `live:${liveKey}`;
  const liveVisible = surface.startsWith("live:");
  const reviewOnScreen = surface.startsWith("review:");
  return (
    <>
      <PaintCapture surface={surface} state={surface === "pending" ? "pending" : "painted"} />
      {terminal ? (
        schemaStale ? (
          <p data-document-schema-stale>
            <Trans>This chapter is temporarily unavailable</Trans>
          </p>
        ) : (
          <ReviewError props={props} />
        )
      ) : null}
      {surface === "pending" ? <PendingEditorShell {...props} /> : null}
      {liveSession ? (
        <PaintScope active={liveVisible}>
          <div data-editor-surface="live" className={liveVisible ? "contents" : "hidden"}>
            <SessionEditorView
              key={liveKey}
              {...props}
              editable={reviewRequested && !closed ? false : props.editable}
              identity={mountIdentity(props, "live")}
              session={liveSession}
              held={!liveVisible || (reviewRequested && !closed)}
            />
          </div>
        </PaintScope>
      ) : null}
      {!terminal && reviewSession && reviewKey ? (
        <PaintScope active={reviewOnScreen}>
          <div data-editor-surface="review" className={reviewOnScreen ? "contents" : "hidden"}>
            <SessionEditorView
              key={reviewKey}
              {...props}
              identity={identity}
              session={reviewSession}
              editable={roomOwner.inputEligible ? props.editable : false}
              onPainted={() => {
                setPaintedReviewKey(reviewKey);
                roomOwner.reportPaint(reviewSession);
              }}
              onUnpainted={() => setPaintedReviewKey(null)}
            />
          </div>
        </PaintScope>
      ) : null}
    </>
  );
}

function ReviewError({ props }: { props: EditorViewProps }) {
  const { controller } = useDraftReview();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="surface-card max-w-sm space-y-3 rounded-lg border border-border-subtle p-4 text-center shadow-sm">
        <p className="font-medium text-foreground text-sm">
          {props.reviewDraftId ? (
            <Trans>Couldn't open review mode.</Trans>
          ) : (
            <Trans>Couldn't open this draft.</Trans>
          )}
        </p>
        <p className="text-muted-foreground text-xs">
          {props.draftOnly ? (
            <Trans>Try again, or close this tab. The draft stays in your list.</Trans>
          ) : (
            <Trans>Try again, or return to the live document.</Trans>
          )}
        </p>
        <div className="flex justify-center gap-2">
          {props.reviewDraftId ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                controller.enterInlineReview(props.documentId, props.reviewDraftId as string)
              }
            >
              <Trans>Retry</Trans>
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={props.draftOnly ? props.onCloseDraftOnly : controller.exitInlineReview}
          >
            {props.draftOnly ? <Trans>Close</Trans> : <Trans>Back to live</Trans>}
          </Button>
        </div>
      </div>
    </div>
  );
}

type SessionEditorViewProps = EditorViewProps & {
  identity: EditorMountIdentity;
  session: DocumentSession;
  /** The live editor kept warm under an active review: its chrome and navigation stand down. */
  held?: boolean;
  /** Called once this mount's TipTap editor exists and is showing its content. */
  onPainted?: () => void;
  onUnpainted?: () => void;
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
  session,
  held = false,
  onPainted,
  onUnpainted,
  snapshot,
  evidenceDegraded,
}: ActiveSessionEditorViewProps) {
  const active = hostActive && !held;
  const { documentId, projectId } = identity;
  const { controller } = useDraftReview();
  const inReview = identity.surface === "review";
  const reviewDraftId = identity.surface === "review" ? identity.draftId : null;
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
  const linkWorkId = !location
    ? null
    : location.scheme === "scratch" || location.scheme === "uploads"
      ? location.workId
      : (noWork?.id ?? null);
  const scope = useMemo<EditorScope>(
    () => ({ projectId: projectId ?? null, workId: linkWorkId }),
    [projectId, linkWorkId],
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
  // and this Work's Scratch, the areas a link names a document in (Uploads
  // hold files, Unfiled holds untitled drafts).
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
    surface: { editable: effectiveEditable, editorProps },
    evidenceDegraded,
  });

  usePaintPending(editor === null);

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
    projectId: projectId ?? null,
    workId: reviewWorkId,
    documentId,
    draftId: reviewDraftId,
    enabled: inReview,
    draftGeneration:
      controller.inlineReview?.documentId === documentId &&
      controller.inlineReview.draftId === reviewDraftId
        ? controller.inlineReview.draftGeneration
        : undefined,
    onInlineModelAvailable: controller.inlineReviewModelAvailable,
  });

  useInlineReviewFocus({
    editor,
    enabled: inReview,
    documentId,
    draftId: reviewDraftId,
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor || inReview || held) return;
    return registerLiveRangeEditor(documentId, editor);
  }, [documentId, editor, inReview, held]);

  const paintCallbacks = useRef({ onPainted, onUnpainted });
  paintCallbacks.current = { onPainted, onUnpainted };
  useEffect(() => {
    if (!editor) return;
    paintCallbacks.current.onPainted?.();
    return () => paintCallbacks.current.onUnpainted?.();
  }, [editor]);

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
                onUploadFigure={() => openImagePicker(editor, imageCaretTarget(editor))}
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
  usePaintPending();
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
