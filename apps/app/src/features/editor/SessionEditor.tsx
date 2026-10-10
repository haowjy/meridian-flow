/** Common document-session editor binding and surface chrome. Review composition is external. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseContextUri } from "@meridian/contracts";
import { WS_CLOSE } from "@meridian/contracts/protocol";
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
import { usePaintPending } from "@/components/app/PaintHold";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import { imageCaretTarget, openImagePicker } from "@/core/editor/images";
import { isLinkDocumentScheme, linkAheadAddress } from "@/core/editor/links";
import { registerLiveRangeEditor } from "@/core/editor/live-range-navigation-runtime";
import { type EditorMountIdentity, useMountedEditor } from "@/core/editor/mounted-editor";
import { usePrefetchTrailDetails } from "@/features/change-trail/trail-detail-query";
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
import "./editor.css";

export type EditorSurfaceOptions = {
  className?: string;
  editable?: boolean;
  showToolbar?: boolean;
  active?: boolean;
  ariaLabel?: string;
  localContentReady?: boolean;
  /** Warm live editors retain UndoManager but stand down their chrome and navigation. */
  held?: boolean;
};

type SessionEditorProps = {
  identity: EditorMountIdentity;
  session: DocumentSession;
  surfaceOptions: EditorSurfaceOptions;
  /** An addressed construction receipt; null withdraws this editor's receipt. */
  onConstructed?: (editor: Editor | null) => void;
};

export function SessionEditor(props: SessionEditorProps) {
  const [snapshot, setSnapshot] = useState(() => props.session.getSnapshot());
  const [bindHorizon, setBindHorizon] = useState<EditorBindHorizonResult | null>(null);
  const requiresFirstServerSync = !(
    props.identity.surface === "live" &&
    (props.identity.detached || props.surfaceOptions.localContentReady)
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

  if (!bindHorizon) return <PendingEditorShell {...props.surfaceOptions} />;

  return (
    <ActiveSessionEditorView
      {...props}
      snapshot={snapshot}
      evidenceDegraded={bindHorizon.evidenceDegraded}
    />
  );
}

type ActiveSessionEditorViewProps = SessionEditorProps & {
  snapshot: DocumentSessionSnapshot;
  evidenceDegraded: boolean;
};

function ActiveSessionEditorView({
  identity,
  surfaceOptions,
  session,
  onConstructed,
  snapshot,
  evidenceDegraded,
}: ActiveSessionEditorViewProps) {
  const {
    className,
    editable = true,
    showToolbar = true,
    active: hostActive = true,
    ariaLabel,
    held = false,
  } = surfaceOptions;
  const active = hostActive && !held;
  const { documentId, projectId } = identity;
  const inReview = identity.surface === "review";
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

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor || inReview || held) return;
    return registerLiveRangeEditor(documentId, editor);
  }, [documentId, editor, inReview, held]);

  const constructionCallback = useRef(onConstructed);
  constructionCallback.current = onConstructed;
  useEffect(() => {
    if (!editor) return;
    constructionCallback.current?.(editor);
    return () => constructionCallback.current?.(null);
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
        <div className="pointer-events-none absolute right-3 bottom-3 z-10">
          <SyncStatus session={session} />
        </div>
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

export function PendingEditorShell({ className, showToolbar = true }: EditorSurfaceOptions) {
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
