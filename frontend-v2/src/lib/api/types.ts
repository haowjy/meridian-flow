import type { Thread } from "@/features/threads/types"

/** API DTOs — camelCase after fetchAPI normalization. */

export type ProjectDto = {
  id: string
  userId: string
  name: string
  slug: string
  isFavorite: boolean
  systemPrompt?: string | null
  autoAcceptProposals?: boolean | null
  lastActivityAt: string
  createdAt: string
  updatedAt: string
}

export type Project = {
  id: string
  name: string
  slug: string
  isFavorite: boolean
  systemPrompt?: string | null
  autoAcceptProposals?: boolean | null
  lastActivityAt: Date
  createdAt: Date
  updatedAt: Date
}

export type ThreadDto = {
  id: string
  projectId: string
  title: string
  lastViewedTurnId: string | null
  createdAt: string
  updatedAt: string
}

export type DocumentDto = {
  id: string
  projectId: string
  folderId: string | null
  name: string
  path: string
  extension: string
  content?: string
  updatedAt: string
}

export type FolderDto = {
  id: string
  projectId: string
  folderId: string | null
  name: string
  createdAt: string
}

export type TreeDocumentDto = {
  id: string
  projectId: string
  folderId: string | null
  name: string
  path: string
  extension: string
  updatedAt: string
  pendingProposalCount?: number
}

export type TreeFolderDto = {
  id: string
  projectId: string
  folderId: string | null
  name: string
  createdAt: string
  updatedAt: string
  folders?: TreeFolderDto[]
  documents?: TreeDocumentDto[]
}

export type DocumentTreeDto = {
  folders: TreeFolderDto[]
  documents: TreeDocumentDto[]
}

export type DocumentTree = {
  folders: TreeFolderNode[]
  documents: TreeDocumentNode[]
}

export type TreeDocumentNode = {
  id: string
  projectId: string
  folderId: string | null
  name: string
  path: string
  extension: string
  updatedAt: Date
  pendingProposalCount?: number
}

export type TreeFolderNode = {
  id: string
  projectId: string
  parentId: string | null
  name: string
  createdAt: Date
  updatedAt: Date
  folders: TreeFolderNode[]
  documents: TreeDocumentNode[]
}

export type TurnBlockDto = {
  id: string
  turnId: string
  blockType: string
  sequence: number
  textContent?: string | null
  content?: Record<string, unknown> | null
  createdAt: string
}

export type TurnDto = {
  id: string
  threadId: string
  prevTurnId?: string | null
  status: string
  error?: string | null
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  role: "user" | "assistant" | "system"
  createdAt: string
  completedAt?: string | null
  blocks?: TurnBlockDto[]
  siblingIds?: string[]
  requestParams?: Record<string, unknown> | null
}

export type PaginatedTurnsDto = {
  turns: TurnDto[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

export type SendTurnResponse = {
  thread?: ThreadDto
  userTurn: TurnDto
  assistantTurn: TurnDto
  streamUrl: string
}

export function fromProjectDto(dto: ProjectDto): Project {
  return {
    id: dto.id,
    name: dto.name,
    slug: dto.slug,
    isFavorite: dto.isFavorite,
    systemPrompt: dto.systemPrompt,
    autoAcceptProposals: dto.autoAcceptProposals,
    lastActivityAt: new Date(dto.lastActivityAt),
    createdAt: new Date(dto.createdAt),
    updatedAt: new Date(dto.updatedAt),
  }
}

export function fromThreadDto(dto: ThreadDto): Thread {
  return {
    id: dto.id,
    projectId: dto.projectId,
    title: dto.title,
    lastViewedTurnId: dto.lastViewedTurnId ?? undefined,
    createdAt: new Date(dto.createdAt),
  }
}

function mapTreeDocument(dto: TreeDocumentDto): TreeDocumentNode {
  return {
    id: dto.id,
    projectId: dto.projectId,
    folderId: dto.folderId,
    name: dto.name,
    path: dto.path,
    extension: dto.extension,
    updatedAt: new Date(dto.updatedAt),
    pendingProposalCount: dto.pendingProposalCount,
  }
}

function mapTreeFolder(dto: TreeFolderDto): TreeFolderNode {
  return {
    id: dto.id,
    projectId: dto.projectId,
    parentId: dto.folderId,
    name: dto.name,
    createdAt: new Date(dto.createdAt),
    updatedAt: new Date(dto.updatedAt),
    folders: (dto.folders ?? []).map(mapTreeFolder),
    documents: (dto.documents ?? []).map(mapTreeDocument),
  }
}

export function fromDocumentTreeDto(dto: DocumentTreeDto): DocumentTree {
  return {
    folders: (dto.folders ?? []).map(mapTreeFolder),
    documents: (dto.documents ?? []).map(mapTreeDocument),
  }
}

export type Document = Omit<DocumentDto, "updatedAt"> & { updatedAt: Date }

export function fromDocumentDto(dto: DocumentDto): Document {
  return {
    ...dto,
    updatedAt: new Date(dto.updatedAt),
  }
}
