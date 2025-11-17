import { Project } from '@/features/projects/types/project'
import { Chat } from '@/features/chats/types'
import { Document, DocumentTree } from '@/features/documents/types/document'
import { Folder } from '@/features/folders/types/folder'

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
  created_at: string  // ISO date string
  updated_at: string  // ISO date string
}

// Chat DTOs
export interface ChatDto {
  id: string
  project_id: string
  title: string
  created_at: string
  updated_at: string
}

// Document DTOs
export interface DocumentDto {
  id: string
  project_id: string
  folder_id: string | null
  name: string
  content?: string
  word_count?: number
  updated_at: string
}

export interface FolderDto {
  id: string
  project_id: string
  folder_id: string | null  // Parent folder ID (renamed from parent_id for API consistency)
  name: string
  created_at: string
  folders?: FolderDto[]      // Nested subfolders (from /tree endpoint)
  documents?: DocumentDto[]  // Nested documents (from /tree endpoint)
}

export interface DocumentTreeDto {
  folders: FolderDto[]      // Root folders (can contain nested folders/documents)
  documents: DocumentDto[]  // Root-level documents only
}

// DTO Mappers
export function fromProjectDto(dto: ProjectDto): Project {
  return {
    id: dto.id,
    name: dto.name,
    createdAt: new Date(dto.created_at),
    updatedAt: new Date(dto.updated_at),
  }
}

export function fromChatDto(dto: ChatDto): Chat {
  return {
    id: dto.id,
    projectId: dto.project_id,
    title: dto.title,
    createdAt: new Date(dto.created_at),
    updatedAt: new Date(dto.updated_at),
  }
}

export function fromDocumentDto(dto: DocumentDto): Document {
  return {
    id: dto.id,
    projectId: dto.project_id,
    folderId: dto.folder_id,
    name: dto.name,
    content: dto.content,
    wordCount: dto.word_count,
    updatedAt: new Date(dto.updated_at),
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

export function fromDocumentTreeDto(dto: DocumentTreeDto): DocumentTree {
  // Flatten nested folder structure recursively
  function flattenFoldersDto(foldersDto: FolderDto[]): Folder[] {
    const result: Folder[] = []

    function flatten(folders: FolderDto[]) {
      for (const folderDto of folders) {
        result.push(fromFolderDto(folderDto))

        if (folderDto.folders && folderDto.folders.length > 0) {
          flatten(folderDto.folders)
        }
      }
    }

    flatten(foldersDto)
    return result
  }

  // Flatten nested document structure recursively
  function flattenDocumentsDto(foldersDto: FolderDto[], documentsDto: DocumentDto[]): Document[] {
    const result: Document[] = []

    // Add root-level documents
    result.push(...documentsDto.map(fromDocumentDto))

    // Recursively extract documents from folders
    function extractDocs(folders: FolderDto[]) {
      for (const folderDto of folders) {
        if (folderDto.documents && folderDto.documents.length > 0) {
          result.push(...folderDto.documents.map(fromDocumentDto))
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
