/**
 * useDocumentContent - Document loading, hydration, and local state management.
 *
 * This hook handles:
 * - Loading documents from the store
 * - Building merged documents (content + aiVersion)
 * - Managing local editor state (content, dirty flag, initialization)
 * - Providing sync context for useDocumentSync
 *
 * Designed for reuse across:
 * - Main editor (with useDocumentSync + useDiffView)
 * - Comment annotations (with useDocumentSync + useCommentView)
 * - Preview boxes (with useDocumentSync, VSCode peek-style)
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useEditorStore } from "@/core/stores/useEditorStore";
import { useLatestRef } from "@/core/hooks";
import { getAdapter } from "@/core/editor/adapters";
import { detectEditorType } from "@/core/editor/types/editorRegistry";
import type { BaseEditorRef } from "@/core/editor/types/editorRegistry";

// =============================================================================
// TYPES
// =============================================================================

interface HydrationInput {
  content: string;
  aiVersion: string | null | undefined;
  aiVersionRev: number | null | undefined;
}

interface PendingSnapshot {
  content: string;
  aiVersion: string | null | undefined;
  aiVersionRev: number | null | undefined;
}

/**
 * Context passed to useDocumentSync for composition.
 * Contains refs and state needed for save/flush logic.
 *
 * @template TEditor - Editor content type (generic to support different editor formats)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DocumentSyncContext<TEditor = any> {
  aiVersionBaseRevRef: React.MutableRefObject<number | null>;
  serverHasAIVersionRef: React.MutableRefObject<boolean>;
  pendingServerSnapshot: PendingSnapshot | null;
  setPendingServerSnapshot: (snapshot: PendingSnapshot | null) => void;
  setHasUserEdit: (value: boolean) => void;
  // Refs for cleanup effects (stale closure prevention)
  localDocumentRef: React.MutableRefObject<TEditor>;
  hasUserEditRef: React.MutableRefObject<boolean>;
  initializedRef: React.MutableRefObject<boolean>;
  activeDocumentRef: React.MutableRefObject<
    ReturnType<typeof useEditorStore.getState>["activeDocument"]
  >;
}

/**
 * Result of useDocumentContent hook.
 *
 * @template TEditor - Editor content type (generic to support different editor formats)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface UseDocumentContentResult<TEditor = any> {
  // Content state
  localDocument: TEditor;
  setLocalDocument: (content: TEditor) => void;
  isInitialized: boolean;
  isEditable: boolean;
  isEditorReady: boolean;
  hasAISuggestions: boolean;

  // Dirty tracking
  hasUserEdit: boolean;
  setHasUserEdit: (value: boolean) => void;

  // Editor lifecycle
  handleEditorReady: (ref: BaseEditorRef<TEditor>) => void;
  handleContentChange: (content: TEditor) => void;
  hydrateDocument: (doc: HydrationInput) => void;

  // For composition (sync hook needs these)
  syncContext: DocumentSyncContext<TEditor>;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Document content hook - Adapter-based multi-editor support.
 *
 * @template TEditor - Editor content type (inferred from extension)
 * @param documentId - Document ID to load
 * @param extension - File extension (used to determine adapter)
 * @param editorRef - Editor reference for programmatic access
 * @returns Document content state and sync context
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useDocumentContent<TEditor = any>(
  documentId: string,
  extension: string,
  editorRef: React.MutableRefObject<BaseEditorRef<TEditor> | null>,
): UseDocumentContentResult<TEditor> {
  // Detect editor type and get adapter
  const editorType = detectEditorType(extension);
  const adapter = getAdapter(editorType);
  // ---------------------------------------------------------------------------
  // STORE STATE
  // ---------------------------------------------------------------------------
  const { activeDocument, _activeDocumentId, isLoading, loadDocument } =
    useEditorStore();

  // ---------------------------------------------------------------------------
  // LOCAL STATE
  // ---------------------------------------------------------------------------

  // Single document (generic type based on adapter)
  // For string-based editors (markdown, latex, plaintext), default to empty string
  // For object-based editors, default to empty object
  const [localDocument, setLocalDocument] = useState<TEditor>(() => {
    return (
      adapter.capabilities.contentFormat === "string" ? "" : {}
    ) as TEditor;
  });
  const [hasUserEdit, setHasUserEdit] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isEditorReady, setIsEditorReady] = useState(false);

  // CAS token for ai_version updates
  const lastHydratedDocIdRef = useRef<string | null>(null);
  const aiVersionBaseRevRef = useRef<number | null>(null);
  // Track if server had an AI version (for flush-on-unmount)
  const serverHasAIVersionRef = useRef(false);
  // Track the last seen activeDocument reference to detect server updates vs local state changes
  const lastActiveDocumentRef = useRef<typeof activeDocument>(null);

  /**
   * Pending server snapshot - stashed when server update arrives while user has edits.
   *
   * State machine:
   * - null: No pending update (normal state)
   * - {content, aiVersion, aiVersionRev}: Server update waiting to be applied
   *
   * Transitions:
   * - Server update arrives + hasUserEdit=true → store snapshot, don't apply
   * - User saves document → clear pendingServerSnapshot after save succeeds
   * - User switches to different document → flush changes, clear snapshot
   *
   * TODO: Add UI for conflict resolution (show diff, let user choose).
   * Currently, pending snapshots are silently overwritten when user saves.
   */
  const [pendingServerSnapshot, setPendingServerSnapshot] =
    useState<PendingSnapshot | null>(null);

  // Refs for "flush on navigate/unmount" without stale closures
  const initializedRef = useLatestRef(isInitialized);
  const localDocumentRef = useLatestRef(localDocument);
  const hasUserEditRef = useLatestRef(hasUserEdit);
  const activeDocumentRef = useLatestRef(activeDocument);

  // Determine editable state early (needed by sync effect below)
  const isEditable =
    isInitialized && activeDocument?.id === documentId && !isLoading;

  // ---------------------------------------------------------------------------
  // CALLBACKS
  // ---------------------------------------------------------------------------

  /**
   * Hydrate editor with document data from server.
   * Used by both initialization and corruption repair.
   * Uses adapter to transform storage → editor format.
   * SRP: Single function for all hydration logic.
   */
  const hydrateDocument = useCallback(
    (doc: HydrationInput) => {
      const content = doc.content;
      const aiVersion = doc.aiVersion;
      // Use adapter to transform storage → editor format
      const editorContent = adapter.toEditor(content, aiVersion) as TEditor;

      setLocalDocument(editorContent);
      aiVersionBaseRevRef.current = doc.aiVersionRev ?? null;
      serverHasAIVersionRef.current = aiVersion != null;
      setHasUserEdit(false);

      if (editorRef.current) {
        editorRef.current.setContent(editorContent, {
          addToHistory: false,
          emitChange: false,
        });
      }
    },
    [adapter, editorRef],
  );

  // Handle content changes from the editor
  const handleContentChange = useCallback(
    (content: TEditor) => {
      // Ignore changes before initialization
      if (!initializedRef.current) {
        return;
      }
      setLocalDocument(content);
      setHasUserEdit(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initializedRef is stable
    [],
  );

  // Handle editor ready
  const handleEditorReady = useCallback(
    (ref: BaseEditorRef<TEditor>) => {
      editorRef.current = ref;
      setIsEditorReady(true);
    },
    [editorRef],
  );

  // ---------------------------------------------------------------------------
  // EFFECTS
  // ---------------------------------------------------------------------------

  // Load document on mount or when documentId changes
  // Note: Flush on unmount is handled by useDocumentSync
  useEffect(() => {
    // Prevent duplicate loads from React Strict Mode double-mounting
    if (_activeDocumentId === documentId && isLoading) {
      return;
    }

    // Create AbortController for this load operation
    const abortController = new AbortController();

    // Reset local editor state on document change
    setIsInitialized(false);
    setHasUserEdit(false);
    setPendingServerSnapshot(null);

    loadDocument(documentId, abortController.signal);

    // Cleanup: abort request if component unmounts or documentId changes
    return () => {
      abortController.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit _activeDocumentId and isLoading to prevent infinite loop
  }, [documentId, loadDocument]);

  // Initialize local document when activeDocument loads
  useEffect(() => {
    if (!activeDocument) return;
    if (activeDocument.id !== documentId) return;

    const docChanged = lastHydratedDocIdRef.current !== activeDocument.id;

    // Detect if the SERVER sent a new document (activeDocument reference changed)
    // vs just local React state changes (hasUserEdit changed).
    // This prevents incorrectly setting pendingServerSnapshot when user makes local edits.
    const serverSentNewDoc = lastActiveDocumentRef.current !== activeDocument;
    lastActiveDocumentRef.current = activeDocument;

    // If same document and no server update, nothing to do.
    // This prevents re-hydration when only hasUserEdit/pendingServerSnapshot changed,
    // which would revert the editor to old content after accept/reject.
    if (!docChanged && !serverSentNewDoc) {
      return;
    }

    // IMPORTANT: Check for existing snapshot FIRST to prevent infinite loop.
    // If we checked hasUserEdit first, we'd create a new pendingServerSnapshot object,
    // which triggers this effect again (it's in deps), creating another object → infinite loop.
    if (!docChanged && pendingServerSnapshot) {
      return;
    }

    // If server sent a new doc for the SAME document ID while user has edits, stash it.
    // Only do this when serverSentNewDoc=true (server update), not when local state changes.
    if (!docChanged && serverSentNewDoc && hasUserEdit) {
      setPendingServerSnapshot({
        content: activeDocument.content ?? "",
        aiVersion: activeDocument.aiVersion,
        aiVersionRev: activeDocument.aiVersionRev,
      });
      return;
    }

    // Initialize the document (new doc or no user edits)
    lastHydratedDocIdRef.current = activeDocument.id;
    setPendingServerSnapshot(null);

    hydrateDocument({
      content: activeDocument.content ?? "",
      aiVersion: activeDocument.aiVersion,
      aiVersionRev: activeDocument.aiVersionRev,
    });

    setIsInitialized(true);
  }, [
    activeDocument,
    documentId,
    hasUserEdit,
    hydrateDocument,
    pendingServerSnapshot,
  ]);

  // Enable diff mode when editor becomes ready (if document has markers)
  // Note: Actual diff extension toggle is handled by useDiffView
  // This effect just ensures editor content is set if loaded before editor ready
  useEffect(() => {
    if (!isEditorReady || !isInitialized) return;

    // If editor just became ready but content was already loaded,
    // ensure editor has the correct content
    const currentEditorContent = editorRef.current?.getContent();
    if (currentEditorContent !== localDocument && localDocument) {
      editorRef.current?.setContent(localDocument, {
        addToHistory: false,
        emitChange: false,
      });
    }
  }, [isEditorReady, isInitialized, localDocument, editorRef]);

  // Sync editable state to editor when it changes
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.setEditable(isEditable);
    }
  }, [isEditable, editorRef]);

  // ---------------------------------------------------------------------------
  // DERIVED STATE
  // ---------------------------------------------------------------------------

  // Check for AI suggestions using adapter
  // Type assertion safe: all current text-based adapters expect string
  const hasAISuggestions = adapter.hasAISuggestions(localDocument as string);

  // ---------------------------------------------------------------------------
  // SYNC CONTEXT (for composition with useDocumentSync)
  // ---------------------------------------------------------------------------

  const syncContext: DocumentSyncContext<TEditor> = {
    aiVersionBaseRevRef,
    serverHasAIVersionRef,
    pendingServerSnapshot,
    setPendingServerSnapshot,
    setHasUserEdit,
    localDocumentRef,
    hasUserEditRef,
    initializedRef,
    activeDocumentRef,
  };

  // ---------------------------------------------------------------------------
  // RETURN
  // ---------------------------------------------------------------------------

  return {
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
  };
}
