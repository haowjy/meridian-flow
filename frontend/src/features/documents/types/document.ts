import { Folder } from "@/features/folders/types/folder";
import type { EditorType } from "@/core/editor/types";

export interface Document {
  id: string;
  projectId: string;
  folderId: string | null;
  /** Display name without extension: "Chapter 5" */
  name: string;
  /** Display path with extension: "Characters/Heroes/Aria.md" (used for URLs) */
  path: string;
  /** File extension with leading dot: ".md", ".excalidraw" */
  extension: string;
  /** Full filename (name + extension): "Chapter 5.md" */
  filename: string;
  content?: string; // Markdown format, lazy-loaded
  wordCount?: number;
  updatedAt: Date;
  /**
   * File type for multi-editor support.
   * Determines which editor to use (CodeMirror for markdown, Excalidraw, Mermaid, etc.)
   * Computed from extension in DTO mapper.
   */
  fileType: EditorType;
  /** Number of pending AI proposals for this document (from tree API) */
  pendingProposalCount?: number;
}

export interface DocumentTree {
  folders: Folder[];
  documents: Document[];
}
