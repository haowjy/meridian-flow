import { Project } from '@/features/projects/types/project'
import { Thread } from '@/features/threads/types'
import { Document, DocumentTree } from '@/features/documents/types/document'
import { Folder } from '@/features/folders/types/folder'
import { detectEditorType } from '@/core/editor/types/editorRegistry'

// API Error Types
export interface ApiErrorResponse {
  error?: string
  message?: string
  code?: string
}

// DTO Types (snake_case from backend)
export interface ProjectDto {
  id: string
  user_id: string
  name: string
  slug: string  // URL-friendly identifier, unique per user
  created_at: string  // ISO date string
  updated_at: string  // ISO date string
}

// Thread DTOs
export interface ThreadDto {
  id: string
  project_id: string
  title: string
  last_viewed_turn_id: string | null
  created_at: string
  updated_at: string
}

// Document metadata structure (format-specific stats)
export interface DocumentMetadataDto {
  markdown?: {
    wordCount?: number
  }
  // Future: image?: { width?: number, height?: number }
  // Future: diagram?: { nodeCount?: number }
}

// Document DTOs
export interface DocumentDto {
  id: string
  project_id: string
  folder_id: string | null
  name: string
  slug: string  // URL-friendly identifier, unique per project
  extension: string  // File extension with leading dot: ".md", ".excalidraw"
  content?: string
  metadata?: DocumentMetadataDto  // Format-specific stats (replaces word_count)
  updated_at: string
  ai_version?: string | null
  ai_version_rev?: number  // CAS revision counter for ai_version
}

export interface FolderDto {
  id: string
  project_id: string
  folder_id: string | null  // Parent folder ID (renamed from parent_id for API consistency)
  name: string
  created_at: string
}

// Tree DTOs (metadata-only, no document content)
export interface TreeDocumentDto {
  id: string
  project_id: string
  folder_id: string | null
  name: string
  slug: string  // URL-friendly identifier, unique per project
  extension: string
  updated_at: string
}

export interface TreeFolderDto {
  id: string
  project_id: string
  folder_id: string | null
  name: string
  created_at: string
  updated_at: string
  folders?: TreeFolderDto[]
  documents?: TreeDocumentDto[]
}

export interface DocumentTreeDto {
  folders: TreeFolderDto[]      // Root folders (can contain nested folders/documents)
  documents: TreeDocumentDto[]  // Root-level documents only
}

// DTO Mappers
export function fromProjectDto(dto: ProjectDto): Project {
  return {
    id: dto.id,
    name: dto.name,
    slug: dto.slug,
    createdAt: new Date(dto.created_at),
    updatedAt: new Date(dto.updated_at),
  }
}

export function fromThreadDto(dto: ThreadDto): Thread {
  return {
    id: dto.id,
    projectId: dto.project_id,
    title: dto.title,
    lastViewedTurnId: dto.last_viewed_turn_id,
    createdAt: new Date(dto.created_at),
    updatedAt: new Date(dto.updated_at),
  }
}

export function fromDocumentDto(dto: DocumentDto): Document {
  // Compute filename from name + extension
  const filename = dto.name + dto.extension
  // Derive fileType from extension (deprecates frontend detectEditorType for most cases)
  const fileType = detectEditorType(filename)

  return {
    id: dto.id,
    projectId: dto.project_id,
    folderId: dto.folder_id,
    name: dto.name,
    slug: dto.slug,
    extension: dto.extension,
    filename,
    fileType,
    content: dto.content,
    wordCount: dto.metadata?.markdown?.wordCount,  // Extract from metadata.markdown
    updatedAt: new Date(dto.updated_at),
    aiVersion: dto.ai_version ?? null,
    aiVersionRev: dto.ai_version_rev,
  }
}

export function fromFolderDto(dto: FolderDto): Folder {
  return {
    id: dto.id,
    projectId: dto.project_id,
    parentId: dto.folder_id,
    name: dto.name,
    createdAt: new Date(dto.created_at),
  }
}

export function fromTreeDocumentDto(dto: TreeDocumentDto): Document {
  const filename = dto.name + dto.extension
  const fileType = detectEditorType(filename)

  return {
    id: dto.id,
    projectId: dto.project_id,
    folderId: dto.folder_id,
    name: dto.name,
    slug: dto.slug,
    extension: dto.extension,
    filename,
    fileType,
    updatedAt: new Date(dto.updated_at),
  }
}

export function fromTreeFolderDto(dto: TreeFolderDto): Folder {
  return {
    id: dto.id,
    projectId: dto.project_id,
    parentId: dto.folder_id,
    name: dto.name,
    createdAt: new Date(dto.created_at),
  }
}

export function fromDocumentTreeDto(dto: DocumentTreeDto): DocumentTree {
  // Flatten nested folder structure recursively
  function flattenFoldersDto(foldersDto: TreeFolderDto[]): Folder[] {
    const result: Folder[] = []

    function flatten(folders: TreeFolderDto[]) {
      for (const folderDto of folders) {
        result.push(fromTreeFolderDto(folderDto))

        if (folderDto.folders && folderDto.folders.length > 0) {
          flatten(folderDto.folders)
        }
      }
    }

    flatten(foldersDto)
    return result
  }

  // Flatten nested document structure recursively
  function flattenDocumentsDto(foldersDto: TreeFolderDto[], documentsDto: TreeDocumentDto[]): Document[] {
    const result: Document[] = []

    // Add root-level documents
    result.push(...documentsDto.map(fromTreeDocumentDto))

    // Recursively extract documents from folders
    function extractDocs(folders: TreeFolderDto[]) {
      for (const folderDto of folders) {
        if (folderDto.documents && folderDto.documents.length > 0) {
          result.push(...folderDto.documents.map(fromTreeDocumentDto))
        }

        if (folderDto.folders && folderDto.folders.length > 0) {
          extractDocs(folderDto.folders)
        }
      }
    }

    extractDocs(foldersDto)
    return result
  }

  return {
    folders: flattenFoldersDto(dto.folders),
    documents: flattenDocumentsDto(dto.folders, dto.documents),
  }
}
