/**
 * EditorPanel - CodeMirror 6 markdown editor with AI diff view support.
 *
 * Key architecture:
 * - Merged document is source of truth (content + aiVersion combined with PUA markers)
 * - Accept/reject are CM6 transactions (undoable via Cmd+Z)
 * - Compartment-based diff extension for dynamic enable/disable
 * - Debounced save parses merged doc back to content + aiVersion
 *
 * Hook composition:
 * - useDocumentContent: Loading, hydration, local state
 * - useDocumentSync: Debounced save, flush on unmount
 * - useDiffView: Diff extension, hunk navigation
 * - useDocumentPolling: Detect background AI updates (polls while AI session active)
 *
 * @see `_docs/plans/ai-editing/inline-suggestions-impl-2/06-integration.md`
 */

import { useRef, useCallback } from "react";
import {
  CodeMirrorEditor,
  EditorContextMenu,
  type CodeMirrorEditorRef,
} from "@/core/editor/codemirror";
import { useEditorStore } from "@/core/stores/useEditorStore";
import { makeLogger } from "@/core/lib/logger";
import { EditorHeader } from "./EditorHeader";
import { ErrorPanel } from "@/shared/components/ErrorPanel";
import { InlineError } from "@/shared/components/InlineError";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { useUIStore } from "@/core/stores/useUIStore";
import {
  PanelHeader,
  HeaderGradientFade,
} from "@/shared/components/layout/headers";
import { SidebarToggle } from "@/shared/components/layout/SidebarToggle";
import { CompactBreadcrumb } from "@/shared/components/ui/CompactBreadcrumb";
import { Button } from "@/shared/components/ui/button";
import { ChevronLeft } from "lucide-react";
import { AIHunkNavigator } from "./AIHunkNavigator";
import {
  useDocumentContent,
  useDocumentSync,
  useDiffView,
  useDocumentPolling,
} from "../hooks";

const log = makeLogger("editor-panel");

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
 * CodeMirror 6 markdown editor panel with AI diff view support.
 *
 * Uses merged document pattern:
 * - On load: buildMergedDocument(content, aiVersion) → editor
 * - During editing: editor shows merged document with diff decorations
 * - On save: parseMergedDocument() → API (content + aiVersion)
 */
export function EditorPanel({
  documentId,
  mobileBackButton,
}: EditorPanelProps) {
  // ---------------------------------------------------------------------------
  // REFS
  // ---------------------------------------------------------------------------
  const editorRef = useRef<CodeMirrorEditorRef | null>(null);

  // ---------------------------------------------------------------------------
  // STORE STATE (for UI that's not in hooks)
  // ---------------------------------------------------------------------------
  const {
    error,
    status,
    lastSaved,
    loadDocument,
    saveDocument,
    clearError,
    navigatorPosition,
  } = useEditorStore();
  const activeDocument = useEditorStore((s) => s.activeDocument);

  // Get document metadata from tree (available immediately, no need to wait for content)
  const documents = useTreeStore((state) => state.documents);
  const documentMetadata = documents.find((doc) => doc.id === documentId);

  // ---------------------------------------------------------------------------
  // HOOKS (composed)
  // ---------------------------------------------------------------------------

  // Get file extension for adapter selection (default to .md if not available yet)
  const extension =
    activeDocument?.extension ?? documentMetadata?.extension ?? ".md";

  // 1. Document content (loading, hydration, local state)
  const {
    localDocument,
    setLocalDocument,
    isInitialized,
    isEditable,
    isEditorReady,
    hasAISuggestions,
    hasUserEdit,
    setHasUserEdit,
    handleEditorReady,
    handleContentChange,
    hydrateDocument,
    syncContext,
  } = useDocumentContent(documentId, extension, editorRef);

  // 2. Document sync (save, flush) - pure effect, no return
  useDocumentSync(
    documentId,
    extension,
    syncContext,
    localDocument,
    hasUserEdit,
    editorRef,
    hydrateDocument,
  );

  // 3. Diff view (markers, navigation)
  const {
    hunks,
    // Note: hasAISuggestions from useDiffView is not used - we use the adapter-based one from useDocumentContent
    initialExtensions,
    handlePrevHunk,
    handleNextHunk,
    handleAcceptAll,
    handleRejectAll,
  } = useDiffView({
    documentId,
    localDocument,
    editorRef,
    isEditorReady,
    setHasUserEdit,
    setLocalDocument,
  });

  // 4. Document polling (detects background AI updates)
  // Polls for aiVersionRev changes when document is open and not being edited.
  // Note: Polls always (not just when AI session active) to detect new AI edits.
  useDocumentPolling(
    {
      documentId,
      currentAIVersionRev: syncContext.aiVersionBaseRevRef.current,
      hasUserEdit,
      intervalMs: 5000,
    },
    {
      onAIVersionChanged: (doc) => {
        // If user has pending edits, stash the update for later
        // Otherwise, hydrate immediately
        if (hasUserEdit) {
          syncContext.setPendingServerSnapshot({
            content: doc.content ?? "",
            aiVersion: doc.aiVersion,
            aiVersionRev: doc.aiVersionRev,
          });
        } else {
          hydrateDocument({
            content: doc.content ?? "",
            aiVersion: doc.aiVersion,
            aiVersionRev: doc.aiVersionRev,
          });
        }
      },
      onError: (error) => {
        // Log but don't disrupt the user - polling will retry
        log.warn("[DocumentPolling] Error:", error.message);
      },
    },
  );

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
  // eslint-disable-next-line react-hooks/refs
  const wordCount = editorRef.current?.getWordCount().words ?? 0;

  const header = headerDocument ? (
    <EditorHeader
      document={headerDocument}
      wordCount={wordCount}
      status={status}
      lastSaved={lastSaved}
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

  const isContentLoading = activeDocument?.id !== documentId || !isInitialized;

  // ---------------------------------------------------------------------------
  // MAIN RENDER
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col">
      {/* Parent scroll container - provides sticky header behavior */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {/* Sticky header - scrolls away when scrolling down, sticks at top when scrolling back up */}
        <div className="bg-background relative sticky top-0 z-20">
          {header}
          <HeaderGradientFade />
        </div>

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
        <div className="relative my-2 flex-1">
          {isContentLoading ? (
            <div className="flex-1" />
          ) : (
            // eslint-disable-next-line react-hooks/refs -- editorRef is stable, passed for context menu operations
            <EditorContextMenu editorRef={editorRef.current}>
              <CodeMirrorEditor
                key={documentId}
                initialContent={localDocument}
                editable={isEditable}
                placeholder="Start writing..."
                onChange={handleContentChange}
                onReady={handleEditorReady}
                extensions={initialExtensions}
                className="min-h-full"
              />
            </EditorContextMenu>
          )}
        </div>

        {/* AI navigator - sticky at bottom of viewport */}
        {hasAISuggestions && hunks.length > 0 && (
          <div className="pointer-events-none sticky right-0 bottom-0 left-0 z-20">
            <AIHunkNavigator
              hunks={hunks}
              currentIndex={navigatorPosition}
              onPrevious={handlePrevHunk}
              onNext={handleNextHunk}
              onAcceptAll={handleAcceptAll}
              onRejectAll={handleRejectAll}
            />
          </div>
        )}
      </div>
    </div>
  );
}
