import { Folder } from '@/features/folders/types/folder'

export interface Document {
  id: string
  projectId: string
  folderId: string | null
  name: string
  content?: string  // Markdown format, lazy-loaded
  wordCount?: number
  updatedAt: Date
}

export interface DocumentTree {
  folders: Folder[]
  documents: Document[]
}
