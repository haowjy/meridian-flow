/**
 * Tool Result Side Effects Registry
 *
 * Centralized handlers for tool result side effects (document refresh, tree updates).
 * Called from handleToolCallResult when a tool completes successfully.
 *
 * SOLID: Open/Closed - add new handlers without modifying existing code.
 * SOLID: Single Responsibility - each handler does exactly one thing.
 */

import { useEditorStore } from "@/core/stores/useEditorStore";
import { useProjectStore } from "@/core/stores/useProjectStore";
import { useTreeStore } from "@/core/stores/useTreeStore";
import {
  findDocumentByPath,
  findFolderByPath,
} from "@/features/threads/utils/docPathResolver";
import type { DocTreeFolder, DocTreeDocument } from "@/types/docTree";

interface ToolResultContext {
  toolName: string;
  content: Record<string, unknown>;
  isError: boolean;
  /** Tool input arguments (from LLM's tool call) */
  input?: Record<string, unknown>;
}

type ToolResultHandler = (ctx: ToolResultContext) => void;

// =============================================================================
// HANDLERS
// =============================================================================

/**
 * Handler for text editor tool results (str_replace_based_edit_tool).
 * Handles both view and edit commands.
 * - For view: Hydrates tree store with folder contents
 * - For create: Triggers tree reload to show new document immediately
 * - For edit operations: Refreshes the edited document if it's currently active
 */
function handleTextEditorResult(ctx: ToolResultContext): void {
  if (ctx.isError) return;

  const command = ctx.input?.command as string | undefined;

  // Handle view command (folder results only - document content handled by component)
  if (command === "view") {
    const type = ctx.content.type as string | undefined;
    if (type !== "folder") return;

    const path = ctx.content.path as string | undefined;
    const viewFolders = ctx.content.folders as
      | Array<{ id: string; name: string }>
      | undefined;
    const viewDocuments = ctx.content.documents as
      | Array<{
          id: string;
          name: string;
          word_count: number;
          updated_at?: string;
        }>
      | undefined;

    if (!viewFolders || !viewDocuments) return;

    const { folders: currentFolders } = useTreeStore.getState();
    const parentFolder = findFolderByPath(path ?? "/", currentFolders);
    const parentFolderId =
      parentFolder === null ? null : (parentFolder?.id ?? null);

    useTreeStore
      .getState()
      .hydrateFromFolderView(parentFolderId, viewFolders, viewDocuments);
    return;
  }

  // Handle edit commands (same logic as legacy doc_edit)
  const path = ctx.input?.path as string | undefined;
  if (!path) return;

  // For create command, reload the entire tree to show new document
  if (command === "create") {
    const projectId = useProjectStore.getState().currentProjectId;
    if (projectId) {
      void useTreeStore.getState().loadTree(projectId);
    }
    return;
  }

  // For edit operations (str_replace, insert), refresh document if currently active
  const { refreshDocument, _activeDocumentId } = useEditorStore.getState();
  const { documents, folders } = useTreeStore.getState();

  const resolvedDoc = findDocumentByPath(path, documents, folders);
  if (resolvedDoc && resolvedDoc.id === _activeDocumentId) {
    void refreshDocument(resolvedDoc.id);
  }
}

/**
 * Handler for doc_edit tool results (legacy).
 * - For create: Triggers tree reload to show new document immediately
 * - For edit operations: Refreshes the edited document if it's currently active
 */
function handleDocEditResult(ctx: ToolResultContext): void {
  if (ctx.isError) return;

  // Path is ALWAYS in the tool INPUT (LLM's request), not the tool RESULT
  const path = ctx.input?.path as string | undefined;
  if (!path) return;

  const command = ctx.input?.command as string | undefined;

  // For create command, reload the entire tree to show new document
  if (command === "create") {
    const projectId = useProjectStore.getState().currentProjectId;
    if (projectId) {
      void useTreeStore.getState().loadTree(projectId);
    }
    return;
  }

  // For edit operations (str_replace, insert, append), refresh document if currently active
  const { refreshDocument, _activeDocumentId } = useEditorStore.getState();
  const { documents, folders } = useTreeStore.getState();

  const resolvedDoc = findDocumentByPath(path, documents, folders);
  if (resolvedDoc && resolvedDoc.id === _activeDocumentId) {
    void refreshDocument(resolvedDoc.id);
  }
}

/**
 * Handler for doc_tree tool results.
 * Hydrates tree store with returned folder/document structure.
 */
function handleDocTreeResult(ctx: ToolResultContext): void {
  if (ctx.isError) return;

  // Tool result may have nested `result` object or flat structure
  const result = ctx.content.result as Record<string, unknown> | undefined;
  const folders = (result?.folders ?? ctx.content.folders) as
    | DocTreeFolder[]
    | undefined;
  const documents = (result?.documents ?? ctx.content.documents) as
    | DocTreeDocument[]
    | undefined;

  if (folders && documents) {
    useTreeStore.getState().hydrateFromToolResult(folders, documents);
  }
}

/**
 * Handler for doc_view tool results (folder listings).
 * Hydrates tree store with folder contents when viewing a folder.
 */
function handleDocViewResult(ctx: ToolResultContext): void {
  if (ctx.isError) return;

  // Only handle folder results (not document content)
  const type = ctx.content.type as string | undefined;
  if (type !== "folder") return;

  const path = ctx.content.path as string | undefined;
  const viewFolders = ctx.content.folders as
    | Array<{ id: string; name: string }>
    | undefined;
  const viewDocuments = ctx.content.documents as
    | Array<{
        id: string;
        name: string;
        word_count: number;
        updated_at?: string;
      }>
    | undefined;

  if (!viewFolders || !viewDocuments) return;

  // Resolve parent folder ID from path
  const { folders: currentFolders } = useTreeStore.getState();
  const parentFolder = findFolderByPath(path ?? "/", currentFolders);

  // findFolderByPath returns:
  // - null for root ("/")
  // - undefined if not found
  // - Folder object if found
  const parentFolderId =
    parentFolder === null ? null : (parentFolder?.id ?? null);

  useTreeStore
    .getState()
    .hydrateFromFolderView(parentFolderId, viewFolders, viewDocuments);
}

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * Registry of tool result handlers.
 * Add new handlers here to extend functionality.
 */
const TOOL_RESULT_HANDLERS: Record<string, ToolResultHandler> = {
  // Unified text editor tool (view + edit combined)
  str_replace_based_edit_tool: handleTextEditorResult,

  // Legacy tool handlers for backward compatibility
  doc_edit: handleDocEditResult,
  doc_tree: handleDocTreeResult,
  doc_view: handleDocViewResult,
};

// =============================================================================
// EXPORTS
// =============================================================================

/**
 * Execute side effects for a tool result.
 * Called from handleToolCallResult when tool completes.
 *
 * @param toolName - Name of the tool (e.g., "doc_edit", "doc_tree")
 * @param content - Parsed JSON content from the tool result
 * @param isError - Whether the tool result indicates an error
 * @param input - Optional tool input arguments (from LLM's tool call)
 */
export function executeToolResultSideEffects(
  toolName: string,
  content: Record<string, unknown>,
  isError: boolean,
  input?: Record<string, unknown>,
): void {
  const handler = TOOL_RESULT_HANDLERS[toolName];
  if (handler) {
    handler({ toolName, content, isError, input });
  }
}
