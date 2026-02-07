/**
 * FolderTreeView - Reusable expandable folder tree component
 *
 * A SOLID-compliant tree view that can be used by multiple tool blocks:
 * - TextEditorBlock: Shows folder contents from str_replace_based_edit_tool view command
 *
 * Design principles:
 * - SRP: Only handles tree rendering, no navigation logic
 * - OCP: Extend via props (showWordCount, custom callbacks)
 * - DIP: Depends on props, not internal stores
 */

import React, { useState, useCallback } from "react";
import { ChevronRight, FolderOpen, Folder, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Document } from "@/features/documents/types/document";
import type { Folder as FolderType } from "@/features/folders/types/folder";

// =============================================================================
// TYPES
// =============================================================================

export interface FolderTreeViewProps {
  /** Starting folder ID (null = project root) */
  rootFolderId: string | null;
  /** All folders in the project */
  folders: FolderType[];
  /** All documents in the project */
  documents: Document[];
  /** Callback when document is clicked */
  onDocumentClick: (doc: Document) => void;
  /** Optional: Show word count for documents */
  showWordCount?: boolean;
  /** Optional: Initially expanded folder IDs */
  initialExpanded?: Set<string>;
  /** Optional: Class name for root container */
  className?: string;
}

interface TreeNodeProps {
  parentId: string | null;
  depth: number;
  folders: FolderType[];
  documents: Document[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onDocumentClick: (doc: Document) => void;
  showWordCount?: boolean;
}

// =============================================================================
// TREE NODE COMPONENT
// =============================================================================

function TreeNode({
  parentId,
  depth,
  folders,
  documents,
  expanded,
  onToggle,
  onDocumentClick,
  showWordCount,
}: TreeNodeProps) {
  // Filter children for this parent
  const childFolders = folders.filter((f) => f.parentId === parentId);
  const childDocs = documents.filter((d) => d.folderId === parentId);

  if (childFolders.length === 0 && childDocs.length === 0) {
    return null;
  }

  return (
    <div className="space-y-0.5">
      {/* Folders first */}
      {childFolders.map((folder) => {
        const isExpanded = expanded.has(folder.id);
        const hasChildren =
          folders.some((f) => f.parentId === folder.id) ||
          documents.some((d) => d.folderId === folder.id);

        return (
          <div key={folder.id}>
            {/* Folder row */}
            <button
              type="button"
              onClick={() => onToggle(folder.id)}
              className={cn(
                "flex w-full items-center gap-1 rounded px-1.5 py-1 text-xs",
                "hover:bg-muted/50 cursor-pointer text-left transition-colors",
                "group",
              )}
              style={{ paddingLeft: `${depth * 12 + 6}px` }}
            >
              {/* Expand indicator */}
              <ChevronRight
                className={cn(
                  "text-muted-foreground/50 h-3 w-3 shrink-0 transition-transform",
                  isExpanded && "rotate-90",
                  !hasChildren && "invisible",
                )}
              />
              {/* Folder icon */}
              {isExpanded ? (
                <FolderOpen className="text-muted-foreground h-3 w-3 shrink-0" />
              ) : (
                <Folder className="text-muted-foreground h-3 w-3 shrink-0" />
              )}
              {/* Folder name */}
              <span className="text-foreground/90 truncate">
                {folder.name}/
              </span>
            </button>

            {/* Children (recursive) */}
            {isExpanded && (
              <TreeNode
                parentId={folder.id}
                depth={depth + 1}
                folders={folders}
                documents={documents}
                expanded={expanded}
                onToggle={onToggle}
                onDocumentClick={onDocumentClick}
                showWordCount={showWordCount}
              />
            )}
          </div>
        );
      })}

      {/* Documents */}
      {childDocs.map((doc) => (
        <button
          key={doc.id}
          type="button"
          onClick={() => onDocumentClick(doc)}
          className={cn(
            "flex w-full items-center gap-1 rounded px-1.5 py-1 text-xs",
            "hover:bg-muted/50 cursor-pointer text-left transition-colors",
          )}
          style={{ paddingLeft: `${depth * 12 + 6 + 16}px` }} // Extra indent to align with folder names
        >
          <FileText className="text-muted-foreground h-3 w-3 shrink-0" />
          <span className="text-foreground/90 truncate">{doc.filename}</span>
          {showWordCount && doc.wordCount !== undefined && (
            <span className="text-muted-foreground ml-auto shrink-0">
              ({doc.wordCount.toLocaleString()} words)
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function FolderTreeView({
  rootFolderId,
  folders,
  documents,
  onDocumentClick,
  showWordCount = false,
  initialExpanded,
  className,
}: FolderTreeViewProps) {
  // Track expanded folders
  const [expanded, setExpanded] = useState<Set<string>>(
    () => initialExpanded ?? new Set(),
  );

  // Toggle folder expansion
  const handleToggle = useCallback((folderId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  // Check if tree is empty
  const hasContent =
    folders.some((f) => f.parentId === rootFolderId) ||
    documents.some((d) => d.folderId === rootFolderId);

  if (!hasContent) {
    return (
      <div
        className={cn("text-muted-foreground py-2 text-xs italic", className)}
      >
        Empty folder
      </div>
    );
  }

  return (
    <div className={className}>
      <TreeNode
        parentId={rootFolderId}
        depth={0}
        folders={folders}
        documents={documents}
        expanded={expanded}
        onToggle={handleToggle}
        onDocumentClick={onDocumentClick}
        showWordCount={showWordCount}
      />
    </div>
  );
}
