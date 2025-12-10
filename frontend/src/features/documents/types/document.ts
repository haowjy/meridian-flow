import { Folder } from '@/features/folders/types/folder'
import type { EditorType } from '@/core/editor/types'

export interface Document {
  id: string
  projectId: string
  folderId: string | null
  name: string
  content?: string  // Markdown format, lazy-loaded
  wordCount?: number
  updatedAt: Date
  /**
   * File type for multi-editor support.
   * Determines which editor to use (CodeMirror for markdown, Excalidraw, Mermaid, etc.)
   * Optional for backwards compatibility - defaults to 'markdown' when undefined.
   */
  fileType?: EditorType
  /**
   * AI-suggested version of the document content.
   * When present, frontend computes diff(content, aiVersion) to show inline suggestions.
   * null/undefined means no pending AI suggestions.
   */
  aiVersion?: string | null
}

export interface DocumentTree {
  folders: Folder[]
  documents: Document[]
}
