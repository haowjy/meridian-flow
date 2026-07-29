/**
 * EditorView — the collaborative document editor surface.
 *
 * Binds a `DocumentSession` (Yjs `Y.Doc` + awareness + cursor provider) to a
 * TipTap/ProseMirror editor and renders the surrounding chrome (sync-status
 * indicator, image-upload drag/drop/paste + inline-command flow).
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
import {
  type ProjectContextTreeNode,
  WS_CLOSE,
  type YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import type { Editor, EditorOptions, JSONContent } from "@tiptap/core";
import type { Mapping } from "@tiptap/pm/transform";
import { EditorContent } from "@tiptap/react";
import { AlertCircle, CheckCircle2, Loader2, UploadCloud } from "lucide-react";
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

import { uploadFigure } from "@/client/api/figures-api";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { SlashCommandItem } from "@/core/editor/extensions/SlashCommandExtension";
import {
  createEditorAssetPathResolver,
  imageAltFromFilename,
  imageAttrsFromUpload,
  isImageFile,
  resolveAssetPathsFromClipboard,
  resolveAssetRefsForClipboard,
} from "@/core/editor/image-workflow";
import { registerLiveRangeEditor } from "@/core/editor/live-range-navigation-runtime";
import { markdownTableClipboardParser } from "@/core/editor/markdown-paste";
import {
  type EditorMountIdentity,
  editorMountKey,
  editorRoomKey,
  useMountedEditor,
} from "@/core/editor/mounted-editor";
import { usePrefetchTrailDetails } from "@/features/change-trail/trail-detail-query";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { cn } from "@/lib/utils";
import { EditorSurfaceFrame } from "./EditorSurfaceFrame";
import { type EditorBindHorizonResult, waitForEditorBindHorizon } from "./editor-bind-horizon";
import { editorColumnCanvas, editorColumnFill, editorProseClass } from "./editor-column";
import { PeerMarkPopover, type PeerMarkPopoverTarget } from "./PeerMarkPopover";
import { SchemaFenceNotice } from "./SchemaFenceNotice";
import { SchemaRepairNotice } from "./SchemaRepairNotice";
import { SyncStatus } from "./SyncStatus";
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

type ImageUploadState =
  | { kind: "idle" }
  | { kind: "uploading"; filename: string; percent: number | null }
  | { kind: "success"; filename: string }
  | { kind: "error"; message: string };

type ImageAttrs = { src: string; alt: string | null; title: null };

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

function droppedImageFile(event: DragEvent): File | null {
  const files = Array.from(event.dataTransfer?.files ?? []);
  return files.find(isImageFile) ?? null;
}

function insertImageNode(editor: Editor | null, attrs: ImageAttrs, pos?: number): boolean {
  if (!editor || editor.isDestroyed) return false;
  const content = { type: "paragraph", content: [{ type: "image", attrs }] } satisfies JSONContent;
  const chain = editor.chain().focus();
  return typeof pos === "number"
    ? chain.insertContentAt(pos, content).run()
    : chain.insertContent(content).run();
}

function imageFileFromClipboard(event: ClipboardEvent): File | null {
  const item = Array.from(event.clipboardData?.items ?? []).find(
    (candidate) => candidate.kind === "file" && candidate.type.startsWith("image/"),
  );
  return item?.getAsFile() ?? null;
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
  ariaLabel,
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
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const clearUploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [imageUploadState, setImageUploadState] = useState<ImageUploadState>({ kind: "idle" });
  // One resolver per mounted editor: `asset:` refs are only meaningful inside
  // this project's asset namespace, and the clipboard translation must not see
  // another project's paths.
  const assetPathResolver = useMemo(() => createEditorAssetPathResolver(), []);
  const { tree: manuscriptTree } = useProjectContextTree(projectId ?? "", "manuscript", {
    enabled: Boolean(projectId),
  });
  const [dragActive, setDragActive] = useState(false);
  const [peerMarkTarget, setPeerMarkTarget] = useState<PeerMarkPopoverTarget | null>(null);
  const effectiveEditableRef = useRef(true);
  const pointerSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const agentNames = useAgentNames(projectId, { enabled: !inReview });
  const effectiveEditable = editable && !snapshot.schemaFence;
  effectiveEditableRef.current = effectiveEditable;

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

  const openPeerMark = useCallback(
    (eventTarget: EventTarget | null, activation: "pointer" | "keyboard"): boolean => {
      if (inReview || !(eventTarget instanceof Element)) return false;
      const element = eventTarget.closest<HTMLElement>("[data-peer-mark]");
      const changeId = element?.dataset.peerMark;
      if (!element || !changeId) return false;
      const marker = session.markerStore
        .getSnapshot()
        .find((candidate) => candidate.changeId === changeId && !candidate.dismissed);
      if (!marker) return false;
      const currentSelection = editorRef.current?.state.selection;
      const editorSelection =
        activation === "pointer" && pointerSelectionRef.current
          ? pointerSelectionRef.current
          : {
              from: currentSelection?.from ?? 0,
              to: currentSelection?.to ?? currentSelection?.from ?? 0,
            };
      setPeerMarkTarget({ marker, element, activation, editorSelection });
      pointerSelectionRef.current = null;
      if (activation === "pointer") {
        requestAnimationFrame(() => {
          const activeEditor = editorRef.current;
          if (!activeEditor || activeEditor.isDestroyed) return;
          activeEditor.chain().setTextSelection(editorSelection).focus().run();
        });
      }
      return true;
    },
    [inReview, session],
  );

  useEffect(() => {
    if (!manuscriptTree) return;
    const remember = (node: ProjectContextTreeNode) => {
      if (node.kind === "file") {
        if (!node.editable && node.fileType === "image") {
          assetPathResolver.remember(node.documentId, node.path.replace(/^\//, ""));
        }
        return;
      }
      for (const child of node.children) remember(child);
    };
    remember(manuscriptTree);
  }, [assetPathResolver, manuscriptTree]);

  // Read when the slash menu opens, so the `t` macros resolve against whatever
  // locale is active then — a locale switch relabels the menu without touching
  // the editor's lifetime.
  //
  // A fence has to withdraw the catalog, not just the surface's editability:
  // slash commands dispatch through TipTap chains, which run on a non-editable
  // editor, so a menu already open when the fence lands would still insert.
  const slashCommandCatalog = useCallback(() => {
    if (identity.schemaType !== "document" || !effectiveEditable) return null;
    return {
      menuLabel: t`Insert block`,
      requestImageUpload: () => imageInputRef.current?.click(),
      items: [
        {
          id: "scene-break",
          label: t`Scene break`,
          aliases: [t`divider`, t`hr`, t`rule`, t`break`],
        },
        { id: "heading", label: t`Heading`, aliases: [t`title`, t`h1`, t`h2`, t`section`] },
        { id: "quote", label: t`Quote`, aliases: [t`blockquote`] },
        { id: "bullet-list", label: t`Bullet list`, aliases: [t`list`] },
        { id: "numbered-list", label: t`Numbered list`, aliases: [t`ordered`] },
        { id: "table", label: t`Table`, aliases: [t`grid`, t`stat block`, t`status`, t`litrpg`] },
        { id: "image", label: t`Image`, aliases: [t`picture`, t`photo`, t`upload`] },
        { id: "code", label: t`Code`, aliases: [t`fence`, t`codeblock`] },
        { id: "diagram", label: t`Diagram`, aliases: [t`mermaid`, t`flowchart`, t`chart`] },
      ] satisfies SlashCommandItem[],
    };
  }, [effectiveEditable, identity.schemaType]);

  const clearUploadLater = useCallback(() => {
    if (clearUploadTimerRef.current) clearTimeout(clearUploadTimerRef.current);
    clearUploadTimerRef.current = setTimeout(() => {
      setImageUploadState({ kind: "idle" });
      clearUploadTimerRef.current = null;
    }, 3000);
  }, []);

  const uploadImageFile = useCallback(
    async (file: File): Promise<ImageAttrs> => {
      if (!projectId) throw new Error(t`A project is required before images can be uploaded.`);
      if (!isImageFile(file)) throw new Error(t`Choose an image file.`);

      setImageUploadState({ kind: "uploading", filename: file.name, percent: null });
      try {
        const reference = await uploadFigure({
          projectId,
          hostDocumentId: documentId,
          file,
          alt: imageAltFromFilename(file.name),
          onProgress: ({ percent }) =>
            setImageUploadState({ kind: "uploading", filename: file.name, percent }),
        });
        assetPathResolver.remember(reference.assetDocumentId, reference.assetPath);
        setImageUploadState({ kind: "success", filename: file.name });
        clearUploadLater();
        return imageAttrsFromUpload(reference);
      } catch (error) {
        setImageUploadState({
          kind: "error",
          message: error instanceof Error ? error.message : t`Image upload failed.`,
        });
        clearUploadLater();
        throw error;
      }
    },
    [assetPathResolver, clearUploadLater, documentId, projectId],
  );

  const handleImageFile = useCallback(
    async (file: File, insertPos?: number): Promise<void> => {
      const targetEditor = editorRef.current;
      // The writer keeps typing during the upload, so the drop/paste position
      // has to ride the same mapping every other transaction does.
      let mappedPos = insertPos;
      const mapPosition = ({ transaction }: { transaction: { mapping: Mapping } }) => {
        if (mappedPos !== undefined) mappedPos = transaction.mapping.map(mappedPos, 1);
      };
      if (targetEditor && mappedPos !== undefined) targetEditor.on("transaction", mapPosition);
      try {
        const attrs = await uploadImageFile(file);
        if (targetEditor && mappedPos !== undefined) targetEditor.off("transaction", mapPosition);
        // The upload outlives the connection that started it: re-read the fence
        // at insert time so a document fenced mid-upload takes no write.
        const inserted =
          effectiveEditableRef.current && !session.getSnapshot().schemaFence
            ? insertImageNode(targetEditor, attrs, mappedPos)
            : false;
        setImageUploadState(
          inserted
            ? { kind: "success", filename: file.name }
            : {
                kind: "error",
                message: t`The image uploaded, but the editor could not insert it.`,
              },
        );
      } catch {
        if (targetEditor && mappedPos !== undefined) targetEditor.off("transaction", mapPosition);
      }
    },
    [session, uploadImageFile],
  );

  // Surface config: applied to the running editor, never a reason to rebuild it.
  // Handlers read editability off the view instead of closing over the prop, so
  // the only thing that moves this object is the chrome it describes.
  const editorProps = useMemo<NonNullable<EditorOptions["editorProps"]>>(
    () => ({
      attributes: {
        class: editorProseClass,
        "aria-label": ariaLabel ?? t`Collaborative document editor`,
      },
      handlePaste(view, event) {
        if (!view.editable) return false;
        const file = imageFileFromClipboard(event);
        if (!file) return false;
        event.preventDefault();
        void handleImageFile(file, view.state.selection.from);
        return true;
      },
      handleDrop(view, event) {
        if (!view.editable) return false;
        const file = droppedImageFile(event);
        if (!file) return false;
        event.preventDefault();
        setDragActive(false);
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void handleImageFile(file, pos);
        return true;
      },
      // Assets travel as stable refs inside the editor and as project-relative
      // paths on the clipboard, so an id never escapes into another surface.
      clipboardTextParser: markdownTableClipboardParser(undefined, assetPathResolver),
      transformCopied: (slice) => resolveAssetRefsForClipboard(slice, assetPathResolver),
      transformPasted: (slice) => resolveAssetPathsFromClipboard(slice, assetPathResolver),
      handleDOMEvents: {
        pointerdown(view, event) {
          if (
            event.target instanceof Element &&
            event.target.closest<HTMLElement>("[data-peer-mark]")
          ) {
            pointerSelectionRef.current = {
              from: view.state.selection.from,
              to: view.state.selection.to,
            };
            // A peer mark is an explanatory decoration, not a new caret
            // destination. Keep the editor focused until the click opens
            // the pointer-mode popover.
            event.preventDefault();
            return true;
          }
          return false;
        },
        click(_view, event) {
          return openPeerMark(event.target, "pointer");
        },
        keydown(_view, event) {
          if (
            (event.key !== "Enter" && event.key !== " ") ||
            !openPeerMark(event.target, "keyboard")
          ) {
            return false;
          }
          event.preventDefault();
          return true;
        },
        dragenter(view, event) {
          if (view.editable && droppedImageFile(event as DragEvent)) setDragActive(true);
          return false;
        },
        dragover(view, event) {
          if (!view.editable || !droppedImageFile(event as DragEvent)) return false;
          event.preventDefault();
          setDragActive(true);
          return true;
        },
        dragleave(_view, event) {
          if (!(event.currentTarget as HTMLElement | null)?.contains(event.relatedTarget as Node)) {
            setDragActive(false);
          }
          return false;
        },
      },
    }),
    [ariaLabel, assetPathResolver, handleImageFile, openPeerMark],
  );

  const editor = useMountedEditor({
    identity,
    session,
    agentNames,
    placeholder: t`Start writing…`,
    slashCommandCatalog,
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
      {snapshot.schemaFence ? <SchemaFenceNotice fence={snapshot.schemaFence} /> : null}
      {snapshot.schemaRepairs.length > 0 ? (
        <SchemaRepairNotice repairs={snapshot.schemaRepairs} />
      ) : null}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void handleImageFile(file);
        }}
      />
      <TrackedEditorCanvas
        editor={editor}
        scrollRef={scrollContainerRef}
        dragActive={dragActive}
        onScroll={(event) => {
          event.currentTarget.dataset.stableLayoutScrollTop = String(event.currentTarget.scrollTop);
          event.currentTarget.dataset.stableLayoutScrollLeft = String(
            event.currentTarget.scrollLeft,
          );
        }}
        dropOverlay={
          effectiveEditable && dragActive ? (
            <div className="meridian-editor-drop-overlay" aria-hidden>
              <UploadCloud className="size-8" />
              <span>
                <Trans>Drop image to insert it</Trans>
              </span>
            </div>
          ) : undefined
        }
        uploadStatus={<ImageUploadStatus state={imageUploadState} />}
      />
      <PeerMarkPopover
        key={peerMarkTarget?.marker.changeId ?? "closed"}
        target={peerMarkTarget}
        onOpenChange={(open) => {
          if (open) return;
          const closingTarget = peerMarkTarget;
          setPeerMarkTarget(null);
          requestAnimationFrame(() => {
            if (closingTarget?.activation === "keyboard") {
              if (closingTarget.element.isConnected) closingTarget.element.focus();
              return;
            }
            const activeEditor = editorRef.current;
            if (!activeEditor || activeEditor.isDestroyed || !closingTarget) return;
            activeEditor.chain().setTextSelection(closingTarget.editorSelection).focus().run();
          });
        }}
      />
    </section>
  );
}

function PendingEditorShell({ className }: EditorViewProps) {
  return (
    <section
      className={cn(
        "meridian-editor-shell relative flex h-full min-h-0 flex-col bg-background",
        className,
      )}
    >
      <TrackedEditorCanvas editor={null} />
    </section>
  );
}

function TrackedEditorCanvas({
  editor,
  scrollRef,
  dragActive = false,
  onScroll,
  dropOverlay,
  uploadStatus,
}: {
  editor: Editor | null;
  scrollRef?: Ref<HTMLDivElement>;
  dragActive?: boolean;
  onScroll?: UIEventHandler<HTMLDivElement>;
  dropOverlay?: ReactNode;
  uploadStatus?: ReactNode;
}) {
  return (
    <EditorSurfaceFrame
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

function ImageUploadStatus({ state }: { state: ImageUploadState }) {
  if (state.kind === "idle") return null;

  return (
    <div
      className={cn(
        "meridian-image-upload-status",
        state.kind === "error" && "meridian-image-upload-status--error",
        state.kind === "success" && "meridian-image-upload-status--success",
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
        {state.kind === "success" ? <Trans>Inserted {state.filename}.</Trans> : null}
        {state.kind === "error" ? state.message : null}
      </span>
    </div>
  );
}
