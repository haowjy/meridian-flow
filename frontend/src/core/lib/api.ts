import { Project } from '@/features/projects/types/project'
import { ProjectDto, fromProjectDto, ApiErrorResponse, APIError } from '@/types/api'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'

export async function fetchAPI<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!response.ok) {
    // Try to parse error response body
    let errorMessage = response.statusText
    let errorCode: string | undefined

    try {
      const errorBody: ApiErrorResponse = await response.json()
      errorMessage = errorBody.message || errorBody.error || errorMessage
      errorCode = errorBody.code
    } catch {
      // If error body can't be parsed, use statusText
    }

    const apiError: APIError = {
      message: errorMessage,
      code: errorCode,
      status: response.status,
    }

    // Create error with message and attach full error object
    const error = new Error(errorMessage) as Error & { apiError: APIError }
    error.apiError = apiError
    throw error
  }

  return response.json()
}

export const api = {
  projects: {
    list: async (): Promise<Project[]> => {
      const data = await fetchAPI<ProjectDto[]>('/api/projects')
      return data.map(fromProjectDto)
    },
    get: async (id: string): Promise<Project> => {
      const data = await fetchAPI<ProjectDto>(`/api/projects/${id}`)
      return fromProjectDto(data)
    },
    create: async (name: string): Promise<Project> => {
      const data = await fetchAPI<ProjectDto>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      return fromProjectDto(data)
    },
    update: async (id: string, name: string): Promise<Project> => {
      const data = await fetchAPI<ProjectDto>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      })
      return fromProjectDto(data)
    },
    delete: (id: string) =>
      fetchAPI<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  },
  // Add documents API later in Phase 4
}
