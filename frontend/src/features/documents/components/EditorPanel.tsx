/**
 * EditorPanel - CodeMirror 6 markdown editor with collab proposal support.
 *
 * Key architecture:
 * - Collab (Yjs) owns document state for supported extensions (.md, .txt)
 * - Non-collab extensions use REST-based content save
 * - AI edits arrive as proposals via WebSocket, auto-accepted into Yjs doc
 *
 * Hook composition:
 * - useDocumentContent: Loading, hydration, local state
 * - useDocumentSync: Debounced save, flush on unmount (non-collab only)
 * - useDocumentCollab: Yjs sync, proposals, connection state
 * - useEditorWikiLinks: Wiki-link extensions, @-mention, broken-link create
 */

import { useRef, useCallback, useMemo } from "react";
import {
  CodeMirrorEditor,
  EditorContextMenu,
  type CodeMirrorEditorRef,
} from "@/core/editor/codemirror";
import { useEditorStore } from "@/core/stores/useEditorStore";
import { ErrorPanel } from "@/shared/components/ErrorPanel";
import { InlineError } from "@/shared/components/InlineError";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { useUIStore } from "@/core/stores/useUIStore";
import { PanelHeader } from "@/shared/components/layout/headers";
import { SidebarToggle } from "@/shared/components/layout/SidebarToggle";
import { CompactBreadcrumb } from "@/shared/components/ui/CompactBreadcrumb";
import { Button } from "@/shared/components/ui/button";
import { ChevronLeft } from "lucide-react";
import { EditorHeader } from "./EditorHeader";
import { EditorWikiLinkPopover } from "./EditorWikiLinkPopover";
import { WikiLinkCreatePopover } from "./WikiLinkCreatePopover";
import { ProposalReviewToolbar } from "./ProposalReviewToolbar";
import {
  useDocumentContent,
  useDocumentCollab,
  useDocumentSync,
  useInlineReview,
} from "../hooks";
import { useEditorWikiLinks } from "../hooks/useEditorWikiLinks";
import { isCollabEnabled } from "../lib/collabFeatureFlag";
import { EditorView } from "@codemirror/view";

const plaintextEditorTheme = EditorView.theme({
  "&": {
    fontFamily: "var(--font-mono)",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
  },
  ".cm-line": {
    fontFamily: "var(--font-mono)",
  },
});

// =============================================================================
// TYPES
// =============================================================================

interface EditorPanelProps {
  documentId: string;
  // Mobile navigation: back button (passed through to EditorHeader)
  mobileBackButton?: React.ReactNode;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * CodeMirror 6 markdown editor panel with collab proposal support.
 */
export function EditorPanel({
  documentId,
  mobileBackButton,
}: EditorPanelProps) {
  // ---------------------------------------------------------------------------
  // REFS
  // ---------------------------------------------------------------------------
  const editorRef = useRef<CodeMirrorEditorRef | null>(null);
  const editorContentRef = useRef<HTMLDivElement | null>(null);

  // ---------------------------------------------------------------------------
  // STORE STATE (for UI that's not in hooks)
  // ---------------------------------------------------------------------------
  const error = useEditorStore((s) => s.error);
  const status = useEditorStore((s) => s.status);
  const lastSaved = useEditorStore((s) => s.lastSaved);
  const loadDocument = useEditorStore((s) => s.loadDocument);
  const saveDocument = useEditorStore((s) => s.saveDocument);
  const clearError = useEditorStore((s) => s.clearError);
  const activeDocument = useEditorStore((s) => s.activeDocument);

  // Get document metadata from tree (available immediately, no need to wait for content)
  const documents = useTreeStore((state) => state.documents);
  const documentMetadata = documents.find((doc) => doc.id === documentId);

  // ---------------------------------------------------------------------------
  // HOOKS (composed)
  // ---------------------------------------------------------------------------

  // Get file extension for adapter selection (default to .md if not available yet).
  // Guard: only use activeDocument.extension when its ID matches the current
  // documentId, otherwise a stale activeDocument from a previous navigation
  // could supply the wrong extension.
  const extension =
    (activeDocument?.id === documentId
      ? activeDocument?.extension
      : undefined) ??
    documentMetadata?.extension ??
    ".md";
  const collabEnabled = isCollabEnabled(extension);

  const editorFontExtensions = useMemo(() => {
    if (extension.toLowerCase() !== ".txt") return [];
    return [plaintextEditorTheme];
  }, [extension]);

  // 1. Document content (loading, hydration, local state)
  const {
    localDocument,
    isInitialized,
    isEditable,
    hasUserEdit,
    handleEditorReady,
    handleContentChange,
    hydrateDocument,
    syncContext,
  } = useDocumentContent(documentId, extension, editorRef);

  // Seed content for collab: use activeDocument content when IDs match,
  // otherwise empty string. No stale state — derived directly each render.
  const collabSeedContent =
    activeDocument?.id === documentId ? (activeDocument?.content ?? "") : "";

  const {
    extensions: collabExtensions,
    connectionState: collabConnectionState,
    operationsModels,
    sendProposalAccept,
    sendProposalReject,
    requestProposalUpdate,
    applyHunkUpdate,
    isReady: isCollabReady,
    getYtextContent,
    idbSynced: isCollabIdbSynced,
  } = useDocumentCollab({
    documentId,
    enabled: collabEnabled && isInitialized,
    initialContent: collabSeedContent,
  });

  // 4. Inline review — wires proposal hunks to CM6 decorations + toolbar
  const { extensions: inlineReviewExts, toolbarProps: reviewToolbarProps } =
    useInlineReview({
      editorRef,
      collabEnabled,
      operationsModels,
      applyHunkUpdate,
      sendProposalAccept,
      sendProposalReject,
      requestProposalUpdate,
    });
  // 2. Document sync (save, flush) — only active for non-collab extensions
  useDocumentSync(
    documentId,
    extension,
    syncContext,
    localDocument,
    hasUserEdit,
    editorRef,
    hydrateDocument,
    !collabEnabled,
  );

  // 3. Wiki-link extensions, @-mention, broken-link create
  const {
    extensions: wikiLinkExtensions,
    atMention,
    popoverPosition,
    handleWikiLinkSelect,
    closeAtMention,
    createPopover,
    isCreating,
    handleCreateFromBrokenLink,
    closeCreatePopover,
    folderPopover,
  } = useEditorWikiLinks(editorRef, editorContentRef);

  // ---------------------------------------------------------------------------
  // CALLBACKS
  // ---------------------------------------------------------------------------

  // Handle back button click
  const handleBackClick = () => {
    const store = useUIStore.getState();
    store.setRightPanelState("documents");
  };

  // ---------------------------------------------------------------------------
  // RENDER HELPERS
  // ---------------------------------------------------------------------------

  // Determine the best available source for header metadata
  const headerDocument =
    documentMetadata ||
    (activeDocument?.id === documentId ? activeDocument : null);

  // Get word count from editor ref
  // Note: This ref access during render is intentional - wordCount is a display-only value
  // that updates on re-render. The ref is stable and always points to our editor instance.
  // eslint-disable-next-line react-hooks/refs -- intentional: display-only value from stable ref
  const wordCount = editorRef.current?.getWordCount().words ?? 0;

  const header = headerDocument ? (
    <EditorHeader
      document={headerDocument}
      wordCount={wordCount}
      status={status}
      lastSaved={lastSaved}
      collabEnabled={collabEnabled}
      collabConnectionState={collabConnectionState}
      mobileBackButton={mobileBackButton}
    />
  ) : (
    <PanelHeader
      leading={
        <>
          <Button
            variant="ghost"
            size="icon"
            className="-ml-1"
            onClick={handleBackClick}
            aria-label="Back to documents"
          >
            <ChevronLeft className="size-3" />
          </Button>
          <CompactBreadcrumb segments={[{ label: "Document" }]} />
        </>
      }
      ariaLabel="Document header"
      showGradient={false}
      trailing={<SidebarToggle side="right" />}
    />
  );

  // ---------------------------------------------------------------------------
  // ERROR STATE
  // ---------------------------------------------------------------------------

  // Determine if this is a load error (document hasn't loaded yet) or save error (document loaded but save failed)
  const isLoadError = error && activeDocument?.id !== documentId;
  const isSaveError =
    error && activeDocument?.id === documentId && status === "error";

  // Handle retry for save errors
  const handleRetry = useCallback(() => {
    if (isSaveError && activeDocument?.content !== undefined) {
      saveDocument(documentId, activeDocument.content);
    }
  }, [isSaveError, activeDocument?.content, saveDocument, documentId]);

  // Full error panel for load errors (document couldn't be loaded at all)
  if (isLoadError) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="flex flex-1 items-center justify-center p-8">
          <ErrorPanel
            title="Failed to load document"
            message={error}
            onRetry={() => loadDocument(documentId)}
          />
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // LOADING STATE
  // ---------------------------------------------------------------------------

  if (!headerDocument) {
    return <div className="flex h-full flex-col" />;
  }

  const isContentLoading =
    activeDocument?.id !== documentId ||
    !isInitialized ||
    // Yjs extensions are not ready yet, so the collab editor cannot mount safely.
    (collabEnabled && !isCollabReady) ||
    // Show editor once IndexedDB cache has loaded (read-only until WS connects).
    // This avoids blocking on WS round-trip for cached content display.
    (collabEnabled && !isCollabIdbSynced);

  // ---------------------------------------------------------------------------
  // MAIN RENDER
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col">
      {/* Parent scroll container - provides sticky header behavior */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {/* Sticky header - scrolls away when scrolling down, sticks at top when scrolling back up */}
        <div className="bg-background relative sticky top-0 z-20">{header}</div>

        {/* Inline error banner for save failures (document is still visible) */}
        {isSaveError && error && (
          <div className="px-4 py-2">
            <InlineError
              message={error}
              onRetry={handleRetry}
              onDismiss={clearError}
            />
          </div>
        )}

        {/* Editor content - scrolls with parent container */}
        <div ref={editorContentRef} className="relative my-2 flex-1">
          {isContentLoading ? (
            // Empty placeholder while loading — consistent blank area for both
            // collab (waiting for WS connection) and non-collab (waiting for content)
            <div className="flex-1" />
          ) : (
            // eslint-disable-next-line react-hooks/refs -- intentional: stable ref passed as prop
            <EditorContextMenu editorRef={editorRef.current}>
              <CodeMirrorEditor
                key={documentId}
                // Collab: use current ytext snapshot so editor doc matches Yjs state
                // at mount time. ySync only applies future deltas, so initial alignment
                // is required to prevent flash-of-empty or stale content divergence.
                initialContent={
                  collabEnabled ? getYtextContent() : localDocument
                }
                editable={isEditable}
                placeholder="Start writing..."
                onChange={handleContentChange}
                onReady={handleEditorReady}
                extensions={[
                  ...collabExtensions,
                  ...wikiLinkExtensions,
                  ...editorFontExtensions,
                  ...inlineReviewExts,
                ]}
                className="min-h-full"
              />
            </EditorContextMenu>
          )}

          {/* Wiki-link @-mention popover (positioned relative to editor) */}
          <EditorWikiLinkPopover
            atMention={atMention}
            position={popoverPosition}
            onSelect={handleWikiLinkSelect}
            onClose={closeAtMention}
          />

          {/* Create-from-broken-link popover (positioned relative to editor) */}
          {createPopover && (
            <WikiLinkCreatePopover
              path={createPopover.path}
              displayName={createPopover.displayName}
              position={createPopover.position}
              onConfirm={handleCreateFromBrokenLink}
              onClose={closeCreatePopover}
              isCreating={isCreating}
              refType={createPopover.refType}
            />
          )}

          {/* Folder content popover (from usePillNavigation) */}
          {folderPopover}

          {/* Floating review toolbar — accept/reject all, hunk navigation */}
          <ProposalReviewToolbar {...reviewToolbarProps} />
        </div>
      </div>
    </div>
  );
}
