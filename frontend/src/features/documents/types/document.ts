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
  /**
   * AI-suggested version of the document content.
   * When present, frontend computes diff(content, aiVersion) to show inline suggestions.
   * null/undefined means no pending AI suggestions.
   */
  aiVersion?: string | null;
  /**
   * Revision counter for ai_version (compare-and-swap token).
   * Used to prevent client saves from overwriting unseen server AI updates.
   * Must be included as ai_version_base_rev when PATCHing ai_version.
   */
  aiVersionRev?: number;
}

export interface DocumentTree {
  folders: Folder[];
  documents: Document[];
}
