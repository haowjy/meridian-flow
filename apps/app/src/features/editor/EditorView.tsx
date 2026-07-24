/**
 * EditorView — the collaborative document editor surface.
 *
 * Binds a `DocumentSession` (Yjs `Y.Doc` + awareness + cursor provider) to a
 * TipTap/ProseMirror editor and renders the surrounding chrome (toolbar,
 * sync-status indicator, figure-upload drag/drop + inline-command flow).
 * Used by the Context screen to open any document. Filename chrome is the
 * host's job (desktop tab strip / phone top-bar breadcrumb), so this view
 * renders no title header of its own.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { AlertCircle, CheckCircle2, Loader2, UploadCloud } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  type UIEventHandler,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { uploadFigure } from "@/client/api/figures-api";
import { createEditorConfig, type EditorUser } from "@/core/editor/config";
import type { DocumentSession } from "@/core/editor/document-session";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import {
  type FigureNodeAttrs,
  figureUploadDefaults,
  isImageFile,
  uploadResponseToFigureNodeAttrs,
} from "@/core/editor/figure-workflow";
import { registerLiveRangeEditor } from "@/core/editor/live-range-navigation-runtime";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { cn } from "@/lib/utils";
import { EditorSurfaceFrame } from "./EditorSurfaceFrame";
import { EditorToolbar } from "./EditorToolbar";
import { editorColumnCanvas, editorColumnFill, editorProseClass } from "./editor-column";
import { PeerMarkPopover, type PeerMarkPopoverTarget } from "./PeerMarkPopover";
import { SyncStatus } from "./SyncStatus";
import { useInlineReviewSync } from "./useInlineReviewSync";
import "./editor.css";

export type EditorViewProps = {
  documentId: string;
  /** Keep a not-yet-materialized live document off server transport. */
  detached?: boolean;
  projectId?: string;
  schemaType?: YjsTrackedSchemaType;
  className?: string;
  user?: EditorUser;
  /** Overrides TipTap editability; mobile passes false while keeping Yjs live. */
  editable?: boolean;
  /** Formatting chrome is hidden for mobile read-only viewing. */
  showToolbar?: boolean;
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

type FigureUploadState =
  | { kind: "idle" }
  | { kind: "uploading"; filename: string; percent: number | null }
  | { kind: "success"; filename: string }
  | { kind: "error"; message: string };

let editorSessionOwnerSequence = 0;

function droppedImageFile(event: DragEvent): File | null {
  const files = Array.from(event.dataTransfer?.files ?? []);
  return files.find(isImageFile) ?? null;
}

function insertFigureNode(editor: Editor | null, attrs: FigureNodeAttrs, pos?: number): boolean {
  if (!editor || editor.isDestroyed) return false;
  const content = { type: "figure", attrs } satisfies JSONContent;
  const chain = editor.chain().focus();
  return typeof pos === "number"
    ? chain.insertContentAt(pos, content).run()
    : chain.insertContent(content).run();
}

export function EditorView(props: EditorViewProps) {
  const { documentId, detached = false, reviewDraftId, reviewRoomName } = props;
  const roomKey = reviewRoomName ?? documentId;
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
  }, [detached, documentId, roomKey]);

  useEffect(() => {
    if (!reviewDraftId || boundSession?.roomKey !== roomKey) return;
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
  }, [boundSession, props.onReviewSessionUnavailable, reviewDraftId, roomKey]);

  const session = boundSession?.roomKey === roomKey ? boundSession : null;

  if (!session) return <PendingEditorShell {...props} />;

  return <SessionEditorView key={roomKey} {...props} session={session} />;
}

type SessionEditorViewProps = EditorViewProps & {
  session: DocumentSession;
};

function SessionEditorView({
  documentId,
  projectId,
  schemaType = "document",
  className,
  user,
  editable = true,
  showToolbar = true,
  ariaLabel,
  showCollaborationDecorations = true,
  reviewDraftId = null,
  reviewWorkId = null,
  onReviewSessionUnavailable,
  session,
}: SessionEditorViewProps) {
  const { controller } = useDraftReview();
  const inReview = Boolean(reviewDraftId);
  const registry = getDocumentSessionRegistry();
  const liveReviewSession = inReview && registry.has(documentId) ? registry.get(documentId) : null;
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const figureInputRef = useRef<HTMLInputElement | null>(null);
  const clearUploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [figureUploadState, setFigureUploadState] = useState<FigureUploadState>({ kind: "idle" });
  const [dragActive, setDragActive] = useState(false);
  const [peerMarkTarget, setPeerMarkTarget] = useState<PeerMarkPopoverTarget | null>(null);

  const openPeerMark = useCallback(
    (eventTarget: EventTarget | null): boolean => {
      if (inReview || !(eventTarget instanceof Element)) return false;
      const element = eventTarget.closest<HTMLElement>("[data-peer-mark]");
      const changeId = element?.dataset.peerMark;
      if (!element || !changeId) return false;
      const marker = session.markerStore
        .getSnapshot()
        .find((candidate) => candidate.changeId === changeId && !candidate.dismissed);
      if (!marker) return false;
      setPeerMarkTarget({ marker, element });
      return true;
    },
    [inReview, session.markerStore],
  );

  const clearUploadLater = useCallback(() => {
    if (clearUploadTimerRef.current) clearTimeout(clearUploadTimerRef.current);
    clearUploadTimerRef.current = setTimeout(() => {
      setFigureUploadState({ kind: "idle" });
      clearUploadTimerRef.current = null;
    }, 3000);
  }, []);

  const handleFigureFile = useCallback(
    async (file: File, insertPos?: number) => {
      if (!projectId) {
        setFigureUploadState({
          kind: "error",
          message: t`A project is required before figures can be uploaded.`,
        });
        return;
      }

      if (!isImageFile(file)) {
        setFigureUploadState({ kind: "error", message: t`Drop an image file to insert a figure.` });
        return;
      }

      const defaults = figureUploadDefaults(file);
      setFigureUploadState({ kind: "uploading", filename: file.name, percent: null });

      try {
        const reference = await uploadFigure({
          projectId,
          documentId,
          file,
          alt: defaults.alt,
          caption: defaults.caption,
          onProgress: ({ percent }) => {
            setFigureUploadState({ kind: "uploading", filename: file.name, percent });
          },
        });
        const inserted = insertFigureNode(
          editorRef.current,
          uploadResponseToFigureNodeAttrs(reference),
          insertPos,
        );
        setFigureUploadState(
          inserted
            ? { kind: "success", filename: file.name }
            : {
                kind: "error",
                message: t`The figure uploaded, but the editor could not insert it.`,
              },
        );
        clearUploadLater();
      } catch (error) {
        setFigureUploadState({
          kind: "error",
          message: error instanceof Error ? error.message : t`Figure upload failed.`,
        });
      }
    },
    [clearUploadLater, documentId, projectId],
  );

  const editor = useEditor(
    {
      ...createEditorConfig({
        document: session.document,
        awareness: session.awareness,
        schemaType,
        cursorProvider: session.cursorProvider,
        user,
        editable,
        placeholder: t`Start writing…`,
        autofocus: false,
        figureRenderContext: { projectId, documentId },
        showCollaborationDecorations,
        enableDraftInlineReview: inReview,
        markerStore: inReview ? undefined : session.markerStore,
        editorProps: {
          attributes: {
            class: editorProseClass(showToolbar ? "docked" : "none"),
            "aria-label": ariaLabel ?? "Collaborative document editor",
          },
          handleTextInput(view, from, _to, text) {
            if (!editable || text !== " ") return false;
            const commandText = "/figure";
            const textBefore = view.state.selection.$from.parent.textBetween(
              0,
              view.state.selection.$from.parentOffset,
              "\n",
              "\n",
            );
            if (!textBefore.endsWith(commandText)) return false;
            view.dispatch(view.state.tr.delete(from - commandText.length, from));
            figureInputRef.current?.click();
            return true;
          },
          handleDrop(view, event) {
            if (!editable) return false;
            const file = droppedImageFile(event);
            if (!file) return false;
            event.preventDefault();
            setDragActive(false);
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            void handleFigureFile(file, pos);
            return true;
          },
          handleDOMEvents: {
            click(_view, event) {
              return openPeerMark(event.target);
            },
            keydown(_view, event) {
              if ((event.key !== "Enter" && event.key !== " ") || !openPeerMark(event.target)) {
                return false;
              }
              event.preventDefault();
              return true;
            },
            dragenter(_view, event) {
              if (editable && droppedImageFile(event as DragEvent)) setDragActive(true);
              return false;
            },
            dragover(_view, event) {
              if (!editable || !droppedImageFile(event as DragEvent)) return false;
              event.preventDefault();
              setDragActive(true);
              return true;
            },
            dragleave(_view, event) {
              if (
                !(event.currentTarget as HTMLElement | null)?.contains(event.relatedTarget as Node)
              ) {
                setDragActive(false);
              }
              return false;
            },
          },
        },
      }),
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
    },
    [
      documentId,
      handleFigureFile,
      projectId,
      schemaType,
      session,
      user,
      editable,
      ariaLabel,
      showCollaborationDecorations,
      inReview,
      openPeerMark,
    ],
  );

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
    if (!inReview || !reviewDraftId || !editor) return;
    // In review mode `session` is the draft session, so `session.document` is the
    // draft Y.Doc the per-card Discard reconstructs its inverse against.
    registerInlineReviewRuntime({
      editor,
      draftDoc: session.document,
      projectId: projectId ?? "",
      workId: reviewWorkId ?? "",
      documentId,
      draftId: reviewDraftId,
    });
    return () => releaseInlineReviewRuntime(editor);
  }, [
    registerInlineReviewRuntime,
    releaseInlineReviewRuntime,
    documentId,
    editor,
    inReview,
    projectId,
    reviewDraftId,
    reviewWorkId,
    session.document,
  ]);

  useInlineReviewSync({
    editor,
    liveSession: liveReviewSession,
    projectId: projectId ?? null,
    workId: reviewWorkId,
    documentId,
    draftId: reviewDraftId,
    enabled: inReview,
    conflictedBlocks: controller.conflictedBlocks,
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

  useEffect(() => {
    return () => {
      const currentEditor = editorRef.current;
      editorRef.current = null;
      if (currentEditor && !currentEditor.isDestroyed) currentEditor.destroy();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (clearUploadTimerRef.current) clearTimeout(clearUploadTimerRef.current);
    };
  }, []);

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
      <input
        ref={figureInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void handleFigureFile(file);
        }}
      />
      <TrackedEditorCanvas
        editor={editor}
        toolbar={
          showToolbar ? (
            <EditorToolbar
              editor={editor}
              onFigureButtonClick={() => figureInputRef.current?.click()}
              figureUploadBusy={figureUploadState.kind === "uploading"}
              figureUploadDisabled={!projectId}
            />
          ) : undefined
        }
        scrollRef={scrollContainerRef}
        dragActive={dragActive}
        onScroll={(event) => {
          event.currentTarget.dataset.stableLayoutScrollTop = String(event.currentTarget.scrollTop);
          event.currentTarget.dataset.stableLayoutScrollLeft = String(
            event.currentTarget.scrollLeft,
          );
        }}
        dropOverlay={
          editable && dragActive ? (
            <div className="meridian-editor-drop-overlay" aria-hidden>
              <UploadCloud className="size-8" />
              <span>
                <Trans>Drop image to upload a figure</Trans>
              </span>
            </div>
          ) : undefined
        }
        uploadStatus={<FigureUploadStatus state={figureUploadState} />}
      />
      <PeerMarkPopover
        key={peerMarkTarget?.marker.changeId ?? "closed"}
        target={peerMarkTarget}
        markerStore={session.markerStore}
        onOpenChange={(open) => {
          if (open) return;
          const mark = peerMarkTarget?.element;
          setPeerMarkTarget(null);
          requestAnimationFrame(() => {
            if (mark?.isConnected) mark.focus();
          });
        }}
      />
    </section>
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
      <TrackedEditorCanvas
        editor={null}
        toolbar={showToolbar ? <EditorToolbar editor={null} figureUploadDisabled /> : undefined}
      />
    </section>
  );
}

function TrackedEditorCanvas({
  editor,
  toolbar,
  scrollRef,
  dragActive = false,
  onScroll,
  dropOverlay,
  uploadStatus,
}: {
  editor: Editor | null;
  toolbar?: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
  dragActive?: boolean;
  onScroll?: UIEventHandler<HTMLDivElement>;
  dropOverlay?: ReactNode;
  uploadStatus?: ReactNode;
}) {
  return (
    <EditorSurfaceFrame
      toolbar={toolbar}
      editor={editor}
      scrollRef={scrollRef}
      scrollClassName={cn(
        "meridian-editor main-pane relative",
        dragActive && "meridian-editor--drag-active",
      )}
      onScroll={onScroll}
    >
      <div className={cn(editorColumnCanvas, editorColumnFill)}>
        <EditorContent editor={editor} className={editorColumnFill} />
      </div>
      {dropOverlay}
      {uploadStatus}
    </EditorSurfaceFrame>
  );
}

function FigureUploadStatus({ state }: { state: FigureUploadState }) {
  if (state.kind === "idle") return null;

  return (
    <div
      className={cn(
        "meridian-figure-upload-status",
        state.kind === "error" && "meridian-figure-upload-status--error",
        state.kind === "success" && "meridian-figure-upload-status--success",
      )}
      role={state.kind === "error" ? "alert" : "status"}
    >
      {state.kind === "uploading" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {state.kind === "success" ? <CheckCircle2 className="size-4" aria-hidden /> : null}
      {state.kind === "error" ? <AlertCircle className="size-4" aria-hidden /> : null}
      <span>
        {state.kind === "uploading" ? (
          state.percent === null ? (
            <Trans>Uploading {state.filename}…</Trans>
          ) : (
            <Trans>
              Uploading {state.filename} — {state.percent}%
            </Trans>
          )
        ) : null}
        {state.kind === "success" ? <Trans>Inserted {state.filename} as a figure.</Trans> : null}
        {state.kind === "error" ? state.message : null}
      </span>
    </div>
  );
}
