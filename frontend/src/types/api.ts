import { Project } from '@/features/projects/types/project'
import { Chat, Message } from '@/features/chats/types'
import { Document, DocumentTree } from '@/features/documents/types/document'
import { Folder } from '@/features/folders/types/folder'

// API Error Types
export interface APIError {
  message: string
  code?: string
  status: number
}

export interface APIResponse<T> {
  data?: T
  error?: APIError
}

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

export interface MessageDto {
  id: string
  chat_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
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
  parent_id: string | null
  name: string
  created_at: string
}

export interface DocumentTreeDto {
  folders: FolderDto[]
  documents: DocumentDto[]
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

export function fromMessageDto(dto: MessageDto): Message {
  return {
    id: dto.id,
    chatId: dto.chat_id,
    role: dto.role,
    content: dto.content,
    createdAt: new Date(dto.created_at),
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
    parentId: dto.parent_id,
    name: dto.name,
    createdAt: new Date(dto.created_at),
  }
}

export function fromDocumentTreeDto(dto: DocumentTreeDto): DocumentTree {
  return {
    folders: dto.folders.map(fromFolderDto),
    documents: dto.documents.map(fromDocumentDto),
  }
}
