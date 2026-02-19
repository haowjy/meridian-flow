import { Project } from "@/features/projects/types/project";
import { Thread } from "@/features/threads/types";
import { Document, DocumentTree } from "@/features/documents/types/document";
import { Folder } from "@/features/folders/types/folder";
import {
  Skill,
  SkillWithContent,
  SkillSyncState,
} from "@/features/skills/types/skill";
import { detectEditorType } from "@/core/editor/types/editorRegistry";

// API Error Types
export interface ApiErrorResponse {
  error?: string;
  message?: string;
  code?: string;
}

// NOTE: All DTO types use camelCase because fetchAPI auto-converts snake_case from backend.
// This is the single gateway for case normalization.

// Project Preferences DTO
export interface ProjectPreferencesDto {
  disabledTools?: string[];
}

// DTO Types (camelCase - auto-converted from backend's snake_case by fetchAPI)
export interface ProjectDto {
  id: string;
  userId: string;
  name: string;
  slug: string; // URL-friendly identifier, unique per user
  isFavorite: boolean; // User's favorite status for quick access (from junction table)
  systemPrompt?: string | null; // Custom AI instructions for the project
  preferences?: ProjectPreferencesDto | null; // Project-level settings
  lastActivityAt: string; // ISO date string - last content activity
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
}

// Thread DTOs
export interface ThreadDto {
  id: string;
  projectId: string;
  title: string;
  lastViewedTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

// Document metadata structure (format-specific stats)
export interface DocumentMetadataDto {
  markdown?: {
    wordCount?: number;
  };
  // Future: image?: { width?: number, height?: number }
  // Future: diagram?: { nodeCount?: number }
}

// Document DTOs
export interface DocumentDto {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  path: string; // Display path with extension: "Characters/Heroes/Aria.md"
  extension: string; // File extension with leading dot: ".md", ".excalidraw"
  content?: string;
  metadata?: DocumentMetadataDto; // Format-specific stats (replaces word_count)
  updatedAt: string;
}

export interface FolderDto {
  id: string;
  projectId: string;
  folderId: string | null; // Parent folder ID (renamed from parent_id for API consistency)
  name: string;
  createdAt: string;
}

// Tree DTOs (metadata-only, no document content)
export interface TreeDocumentDto {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  path: string; // Display path with extension: "Characters/Heroes/Aria.md"
  extension: string;
  updatedAt: string;
  pendingProposalCount?: number; // Number of pending AI proposals for this document
}

export interface TreeFolderDto {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  folders?: TreeFolderDto[];
  documents?: TreeDocumentDto[];
}

export interface DocumentTreeDto {
  folders: TreeFolderDto[]; // Root folders (can contain nested folders/documents)
  documents: TreeDocumentDto[]; // Root-level documents only
}

// Skill DTOs
export interface SkillDto {
  id: string;
  projectId: string;
  name: string; // Internal identifier (e.g., "writing-coach")
  description: string;
  position: number; // Sort order for display
  enabled: boolean; // Whether skill is active
  disableModelInvocation: boolean;
  userInvocable: boolean;
  syncState: string; // 'detached' | 'synced' | 'outdated'
  isDirty: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillWithContentDto extends SkillDto {
  content: string; // Full SKILL.md content
}

export interface SkillListResponseDto {
  skills: SkillDto[];
  count: number;
}

// DTO Mappers
// NOTE: With fetchAPI's auto-conversion, these now mainly handle Date conversions.
export function fromProjectDto(dto: ProjectDto): Project {
  return {
    id: dto.id,
    name: dto.name,
    slug: dto.slug,
    isFavorite: dto.isFavorite,
    systemPrompt: dto.systemPrompt,
    preferences: dto.preferences
      ? {
          disabledTools: dto.preferences.disabledTools,
        }
      : undefined,
    lastActivityAt: new Date(dto.lastActivityAt),
    createdAt: new Date(dto.createdAt),
    updatedAt: new Date(dto.updatedAt),
  };
}

export function fromThreadDto(dto: ThreadDto): Thread {
  return {
    id: dto.id,
    projectId: dto.projectId,
    title: dto.title,
    lastViewedTurnId: dto.lastViewedTurnId,
    createdAt: new Date(dto.createdAt),
    updatedAt: new Date(dto.updatedAt),
  };
}

export function fromDocumentDto(dto: DocumentDto): Document {
  // Compute filename from name + extension
  const filename = dto.name + dto.extension;
  // Derive fileType from extension (deprecates frontend detectEditorType for most cases)
  const fileType = detectEditorType(filename);

  return {
    id: dto.id,
    projectId: dto.projectId,
    folderId: dto.folderId,
    name: dto.name,
    path: dto.path,
    extension: dto.extension,
    filename,
    fileType,
    content: dto.content,
    wordCount: dto.metadata?.markdown?.wordCount, // Extract from metadata.markdown
    updatedAt: new Date(dto.updatedAt),
  };
}

export function fromFolderDto(dto: FolderDto): Folder {
  return {
    id: dto.id,
    projectId: dto.projectId,
    parentId: dto.folderId,
    name: dto.name,
    createdAt: new Date(dto.createdAt),
  };
}

export function fromTreeDocumentDto(dto: TreeDocumentDto): Document {
  const filename = dto.name + dto.extension;
  const fileType = detectEditorType(filename);

  return {
    id: dto.id,
    projectId: dto.projectId,
    folderId: dto.folderId,
    name: dto.name,
    path: dto.path,
    extension: dto.extension,
    filename,
    fileType,
    updatedAt: new Date(dto.updatedAt),
    pendingProposalCount: dto.pendingProposalCount,
  };
}

export function fromTreeFolderDto(dto: TreeFolderDto): Folder {
  return {
    id: dto.id,
    projectId: dto.projectId,
    parentId: dto.folderId,
    name: dto.name,
    createdAt: new Date(dto.createdAt),
  };
}

export function fromDocumentTreeDto(dto: DocumentTreeDto): DocumentTree {
  // Flatten nested folder structure recursively
  function flattenFoldersDto(foldersDto: TreeFolderDto[]): Folder[] {
    const result: Folder[] = [];

    function flatten(folders: TreeFolderDto[]) {
      for (const folderDto of folders) {
        result.push(fromTreeFolderDto(folderDto));

        if (folderDto.folders && folderDto.folders.length > 0) {
          flatten(folderDto.folders);
        }
      }
    }

    flatten(foldersDto);
    return result;
  }

  // Flatten nested document structure recursively
  function flattenDocumentsDto(
    foldersDto: TreeFolderDto[],
    documentsDto: TreeDocumentDto[],
  ): Document[] {
    const result: Document[] = [];

    // Add root-level documents
    result.push(...documentsDto.map(fromTreeDocumentDto));

    // Recursively extract documents from folders
    function extractDocs(folders: TreeFolderDto[]) {
      for (const folderDto of folders) {
        if (folderDto.documents && folderDto.documents.length > 0) {
          result.push(...folderDto.documents.map(fromTreeDocumentDto));
        }

        if (folderDto.folders && folderDto.folders.length > 0) {
          extractDocs(folderDto.folders);
        }
      }
    }

    extractDocs(foldersDto);
    return result;
  }

  return {
    folders: flattenFoldersDto(dto.folders),
    documents: flattenDocumentsDto(dto.folders, dto.documents),
  };
}

export function fromSkillDto(dto: SkillDto): Skill {
  return {
    id: dto.id,
    projectId: dto.projectId,
    name: dto.name,
    description: dto.description,
    position: dto.position,
    enabled: dto.enabled,
    disableModelInvocation: dto.disableModelInvocation,
    userInvocable: dto.userInvocable,
    syncState: dto.syncState as SkillSyncState,
    isDirty: dto.isDirty,
    createdAt: new Date(dto.createdAt),
    updatedAt: new Date(dto.updatedAt),
  };
}

export function fromSkillWithContentDto(
  dto: SkillWithContentDto,
): SkillWithContent {
  return {
    ...fromSkillDto(dto),
    content: dto.content,
  };
}
