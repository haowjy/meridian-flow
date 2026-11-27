import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseContextUri } from "@meridian/contracts";
import { WS_CLOSE } from "@meridian/contracts/protocol";
import type { Editor, EditorOptions } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import {
  type ReactNode,
  type RefObject,
  type UIEventHandler,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useProjectTrees } from "@/client/query/useProjectTrees";
import { useRefreshTurnCardsOnEdit } from "@/client/query/useTurnLiveLineage";
import { useWorks } from "@/client/query/useWorks";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { useAfterPaintRelease, usePaintPending } from "@/components/app/PaintHold";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import { editorReferenceNode } from "@/core/editor/extensions/at-reference";
import { imageCaretTarget, openImagePicker } from "@/core/editor/images";
import { isLinkDocumentScheme, linkAheadAddress } from "@/core/editor/links";
import { registerLiveRangeEditor } from "@/core/editor/live-range-navigation-runtime";
import { type EditorMountIdentity, useMountedEditor } from "@/core/editor/mounted-editor";
import { holdPictureCapThroughKeyboard } from "@/core/editor/objects";
import { useReadingPosition } from "@/core/editor/use-reading-position";
import { useLinkableDocuments } from "@/features/links";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import { referenceDropOptions } from "@/features/project/context/entry-drag/reference-drop-options";
import { removalAnswer } from "@/features/project/context/removal-answer";
import { useDocumentStanding } from "@/features/project/context/use-document-standing";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { focusIsFree } from "@/lib/focus-follow";
import {
  DocumentStateSlotHost,
  DocumentToolbarSlotHost,
  useToolbarTaken,
} from "./document-state-slot";
import { EditorChromeHost } from "./EditorChromeHost";
import { EditorSurfaceFrame } from "./EditorSurfaceFrame";
import { editorColumnFill, editorProseClass } from "./editor-column";
import { type EditorScope, EditorScopeProvider } from "./editor-scope";
import { claimEditorFocus, joinMain } from "./focus-on-open";
import { InTrashStatus } from "./InTrashStatus";
import { useReferenceBrowserCatalog } from "./references/useReferenceBrowserCatalog";
import { SchemaNotices } from "./SchemaNotices";
import { SyncStatus } from "./SyncStatus";
import { FileDropRuntime } from "./surfaces/files";
import { ImageIngressRuntime } from "./surfaces/images";
import { ProjectLinkRuntime } from "./surfaces/link";
import { documentSlashCatalog } from "./surfaces/slash";
import { DocumentToolbar } from "./surfaces/toolbar";
import { WordCount } from "./WordCount";
import "./editor.css";

export type EditorSurfaceOptions = {
  editable?: boolean;
  showToolbar?: boolean;
  active?: boolean;
  ariaLabel?: string;
  localContentReady?: boolean;
  held?: boolean;
};

type SessionEditorProps = {
  identity: EditorMountIdentity;
  session: DocumentSession;
  surfaceOptions: EditorSurfaceOptions;
  holderUri?: string | null;
  focusKey?: string;
  inMain?: boolean;
};

const FIRST_PAINT_WAIT_MS = 5_000;

export function SessionEditor(props: SessionEditorProps) {
  const [snapshot, setSnapshot] = useState(() => viewOf(props.session.getSnapshot()));
  const [bindable, setBindable] = useState(false);
  const requiresFirstServerSync = !(
    props.identity.detached || props.surfaceOptions.localContentReady
  );

  useEffect(
    () =>
      props.session.subscribe((next) =>
        setSnapshot((shown) => (sameView(shown, next) ? shown : viewOf(next))),
      ),
    [props.session],
  );
  useEffect(() => {
    let active = true;
    const bind = () => {
      if (active) setBindable(true);
    };
    const timeout = setTimeout(bind, FIRST_PAINT_WAIT_MS);
    void Promise.allSettled([
      props.session.whenLocalPersistenceSynced(),
      ...(requiresFirstServerSync ? [props.session.whenSynced()] : []),
    ]).then(bind);
    return () => {
      active = false;
      clearTimeout(timeout);
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

  if (!bindable) return <PendingEditorShell {...props.surfaceOptions} />;

  return <ActiveSessionEditorView {...props} snapshot={snapshot} />;
}

type SessionView = Pick<DocumentSessionSnapshot, "connectionState" | "schemaFence" | "access">;

const viewOf = ({
  connectionState,
  schemaFence,
  access,
}: DocumentSessionSnapshot): SessionView => ({
  connectionState,
  schemaFence,
  access,
});

const sameView = (shown: SessionView, next: DocumentSessionSnapshot) =>
  shown.connectionState === next.connectionState &&
  shown.schemaFence === next.schemaFence &&
  shown.access === next.access;

type ActiveSessionEditorViewProps = SessionEditorProps & { snapshot: SessionView };

function ActiveSessionEditorView({
  identity,
  surfaceOptions,
  session,
  focusKey,
  inMain = false,
  holderUri: reviewHolderUri,
  snapshot,
}: ActiveSessionEditorViewProps) {
  const {
    editable = true,
    showToolbar = true,
    active: hostActive = true,
    ariaLabel,
    held = false,
  } = surfaceOptions;
  const active = hostActive && !held;
  const accountId = useAccountId();
  const accountEpoch = useAccountEpochSignal();
  const { documentId, projectId } = identity;
  const removed =
    snapshot.connectionState?.kind === "reset" &&
    snapshot.connectionState.disposition === "removed";
  const removal = removalAnswer(
    useDocumentStanding(projectId ?? "", removed && projectId ? documentId : null),
  );
  const documentInTrash = removal?.kind === "removed" && removal.inTrash;
  const editorRef = useRef<Editor | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const effectiveEditableRef = useRef(true);
  const effectiveEditable = editable && !snapshot.schemaFence && snapshot.access !== "read";
  effectiveEditableRef.current = effectiveEditable;

  const { noWork } = useWorks(projectId ?? "", { enabled: Boolean(projectId) });
  const holder = useProjectTrees(projectId ?? "").find(documentId);
  const holderOwner = holder?.source.owner;
  const linkRootThreadId = holderOwner?.kind === "lineage" ? holderOwner.rootThreadId : null;
  const linkWorkId = !holderOwner
    ? null
    : linkRootThreadId
      ? (noWork?.id ?? null)
      : holderOwner.kind === "work"
        ? holderOwner.workId
        : holderOwner.kind === "chat"
          ? null
          : (noWork?.id ?? null);
  const scope = useMemo<EditorScope>(
    () => ({ projectId: projectId ?? null, workId: linkWorkId, rootThreadId: linkRootThreadId }),
    [projectId, linkWorkId, linkRootThreadId],
  );

  // A fence has to withdraw the catalog, not just the surface's editability:
  // slash commands dispatch through TipTap chains, which run on a non-editable
  // editor, so a menu already open when the fence lands would still insert.
  const slashCommandCatalog = useCallback(() => {
    if (identity.schemaType !== "document" || !effectiveEditable) return null;
    return documentSlashCatalog((at) => openImagePicker(editorRef.current, { kind: "insert", at }));
  }, [effectiveEditable, identity.schemaType]);

  const linkableDocuments = useLinkableDocuments(
    active ? scope : { projectId: null, workId: null },
  );
  const indexedHolderUri = useMemo(
    () =>
      linkableDocuments.documents.find((document) => document.documentId === documentId)?.uri ??
      null,
    [linkableDocuments, documentId],
  );
  const holderUri = reviewHolderUri ?? indexedHolderUri;
  const sharedReferenceCatalog = useReferenceBrowserCatalog(
    active ? projectId : null,
    active ? scope.workId : null,
    t`Reference a file`,
    active ? scope.rootThreadId : null,
  );
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
  const atReferenceCatalog = useCallback(() => {
    if (identity.schemaType !== "document" || !effectiveEditable || !sharedReferenceCatalog)
      return null;
    return {
      ...sharedReferenceCatalog,
      referenceNode: editorReferenceNode,
      linkAhead: (name: string) => linkAhead(name),
    };
  }, [effectiveEditable, identity.schemaType, linkAhead, sharedReferenceCatalog]);
  const referenceDrop = useMemo(
    () =>
      referenceDropOptions({
        catalog: () =>
          sharedReferenceCatalog && {
            ...sharedReferenceCatalog,
            referenceNode: editorReferenceNode,
          },
        labels: {
          accept: t`Mention`,
          unavailable: t`Can’t mention that here`,
          code: t`Can’t mention inside code`,
        },
      }),
    [sharedReferenceCatalog],
  );
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
  const wikilinkPasteCatalog = useCallback(
    () =>
      identity.schemaType === "document" && linkableDocuments.complete
        ? { holderUri, targets: pasteTargets, linkAhead }
        : null,
    [holderUri, identity.schemaType, linkAhead, linkableDocuments.complete, pasteTargets],
  );

  const leaveHintId = useId();
  const editorProps = useMemo<NonNullable<EditorOptions["editorProps"]>>(
    () => ({
      attributes: {
        class: editorProseClass(showToolbar ? "docked" : "none"),
        "aria-label": ariaLabel ?? t`Collaborative document editor`,
        "aria-describedby": leaveHintId,
      },
    }),
    [ariaLabel, showToolbar, leaveHintId],
  );

  const editor = useMountedEditor({
    identity,
    session,
    user: { accountId },
    placeholder: t`Start writing…`,
    slashCommandCatalog,
    atReferenceCatalog,
    referenceDrop,
    wikilinkPasteCatalog,
    surface: { editable: effectiveEditable, editorProps, publishPresence: active },
  });

  usePaintPending(editor === null);
  useRefreshTurnCardsOnEdit(editor, documentId);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  const afterPaintRelease = useAfterPaintRelease();
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onFocusOut = (event: FocusEvent) => {
      if (
        !(
          event.relatedTarget instanceof Element &&
          event.relatedTarget.hasAttribute("data-paint-status")
        )
      )
        return;
      afterPaintRelease(() => {
        if (!editor.isDestroyed && document.activeElement?.hasAttribute("data-paint-status"))
          editor.view.focus();
      });
    };
    dom.addEventListener("focusout", onFocusOut);
    return () => dom.removeEventListener("focusout", onFocusOut);
  }, [afterPaintRelease, editor]);

  useEffect(() => {
    if (!editor || !active) return;
    const made = effectiveEditable && claimEditorFocus(focusKey);
    if (!made && !inMain) return;
    let release: (() => void) | null = null;
    let mounted = true;
    afterPaintRelease(() => {
      if (!mounted || editor.isDestroyed) return;
      if (made && focusIsFree()) editor.commands.focus("start", { scrollIntoView: false });
      if (inMain) release = joinMain(editor.view.dom, { text: true });
    });
    return () => {
      mounted = false;
      release?.();
    };
  }, [afterPaintRelease, active, inMain, editor, effectiveEditable, focusKey]);

  useEffect(() => {
    if (!editor || !active) return;
    return registerLiveRangeEditor(documentId, {
      editor,
      session,
      localContentReady: surfaceOptions.localContentReady === true,
    });
  }, [active, documentId, editor, session, surfaceOptions.localContentReady]);

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
    session,
    signal: accountEpoch,
  });

  return (
    <EditorScopeProvider
      projectId={scope.projectId}
      workId={scope.workId}
      rootThreadId={scope.rootThreadId}
    >
      <section className="meridian-editor-shell relative flex h-full min-h-0 flex-col">
        <div className="pointer-events-none absolute right-3 bottom-3 z-10 flex items-center gap-3 rounded-full border border-border-subtle bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-float empty:hidden">
          {projectId && documentInTrash ? (
            <InTrashStatus documentId={documentId} />
          ) : (
            <SyncStatus session={session} />
          )}
          {editor ? <WordCount editor={editor} /> : null}
        </div>
        <EditorCanvas
          editor={editor}
          active={active}
          notices={<SchemaNotices fence={snapshot.schemaFence} />}
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
        <EditorChromeHost editor={editor} active={active} />
        <span id={leaveHintId} hidden>
          <Trans>Tab types a tab. To leave the document, press Escape, then Tab.</Trans>
        </span>
        <ProjectLinkRuntime
          editor={editor}
          documentId={documentId}
          baseUri={holderUri}
          index={linkableDocuments}
          active={active}
        />
        <ImageIngressRuntime editor={editor} projectId={projectId} holderUri={holderUri} />
        <FileDropRuntime editor={editor} documentId={documentId} holderUri={holderUri} />
      </section>
    </EditorScopeProvider>
  );
}

export function PendingEditorShell({
  showToolbar = true,
  active = true,
  held = false,
}: EditorSurfaceOptions) {
  usePaintPending();
  return (
    <section className="meridian-editor-shell relative flex h-full min-h-0 flex-col">
      <EditorCanvas
        editor={null}
        active={active && !held}
        toolbar={showToolbar ? <DocumentToolbar editor={null} /> : undefined}
      />
    </section>
  );
}

function EditorCanvas({
  editor,
  active,
  notices,
  toolbar,
  scrollRef,
  onScroll,
}: {
  editor: Editor | null;
  active: boolean;
  notices?: ReactNode;
  toolbar?: ReactNode;
  scrollRef?: RefObject<HTMLDivElement | null>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}) {
  const touch = useCoarsePointer();
  const taken = useToolbarTaken() && active;
  useEffect(
    () =>
      editor && touch && scrollRef?.current
        ? holdPictureCapThroughKeyboard(editor.view, scrollRef.current)
        : undefined,
    [editor, touch, scrollRef],
  );

  return (
    <EditorSurfaceFrame
      notices={notices}
      toolbar={toolbar}
      toolbarHeld={taken ? <DocumentToolbarSlotHost /> : null}
      toolbarTrailing={active ? <DocumentStateSlotHost /> : null}
      textCursor={editor !== null}
      scrollRef={scrollRef}
      scrollClassName="meridian-editor main-pane"
      onScroll={onScroll}
    >
      {editor ? (
        <EditorContent editor={editor} className={editorColumnFill} />
      ) : (
        <DelayedContentSkeleton />
      )}
    </EditorSurfaceFrame>
  );
}
