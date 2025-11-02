import { Project } from '@/features/projects/types/project'

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

// DTO Mappers
export function fromProjectDto(dto: ProjectDto): Project {
  return {
    id: dto.id,
    name: dto.name,
    createdAt: new Date(dto.created_at),
    updatedAt: new Date(dto.updated_at),
  }
}
