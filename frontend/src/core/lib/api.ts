import { Project } from '@/features/projects/types/project'
import { Chat, Message } from '@/features/chats/types'
import { Document, DocumentTree } from '@/features/documents/types/document'
import {
  ProjectDto,
  ChatDto,
  MessageDto,
  DocumentDto,
  DocumentTreeDto,
  fromProjectDto,
  fromChatDto,
  fromMessageDto,
  fromDocumentDto,
  fromDocumentTreeDto,
  ApiErrorResponse,
} from '@/types/api'
import { httpErrorToAppError } from '@/core/lib/errors'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'

export async function fetchAPI<T>(
  endpoint: string,
  options?: RequestInit & { signal?: AbortSignal }
): Promise<T> {
  try {
    // Only set Content-Type if request has a body
    const headers: Record<string, string> = {
      ...options?.headers,
    }
    if (options?.body) {
      headers['Content-Type'] = 'application/json'
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      signal: options?.signal,
      headers,
    })

    if (!response.ok) {
      // Try to parse error response body
      let errorMessage = response.statusText

      try {
        const errorBody: ApiErrorResponse = await response.json()
        errorMessage = errorBody.message || errorBody.error || errorMessage
      } catch {
        // If error body can't be parsed, use statusText
      }

      // Throw standardized AppError
      throw httpErrorToAppError(response.status, errorMessage)
    }

    // Handle 204 No Content or empty responses (DELETE operations)
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as any
    }

    return response.json()
  } catch (error) {
    // If it's already an AppError or AbortError, rethrow as-is
    if (error instanceof Error && (error.name === 'AbortError' || error.constructor.name === 'AppError')) {
      throw error
    }

    // Network errors (TypeError, etc.) - wrap in AppError
    if (error instanceof TypeError) {
      const { ErrorType, AppError } = await import('./errors')
      throw new AppError(
        ErrorType.Network,
        'Network error: Unable to connect to server. Please check your connection.'
      )
    }

    // Unknown errors - wrap in AppError
    const { ErrorType, AppError } = await import('./errors')
    const message = error instanceof Error ? error.message : 'An unexpected error occurred'
    throw new AppError(ErrorType.Unknown, message)
  }
}

export const api = {
  projects: {
    list: async (options?: { signal?: AbortSignal }): Promise<Project[]> => {
      const data = await fetchAPI<ProjectDto[]>('/api/projects', {
        signal: options?.signal,
      })
      return data.map(fromProjectDto)
    },
    get: async (id: string, options?: { signal?: AbortSignal }): Promise<Project> => {
      const data = await fetchAPI<ProjectDto>(`/api/projects/${id}`, {
        signal: options?.signal,
      })
      return fromProjectDto(data)
    },
    create: async (name: string, options?: { signal?: AbortSignal }): Promise<Project> => {
      const data = await fetchAPI<ProjectDto>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name }),
        signal: options?.signal,
      })
      return fromProjectDto(data)
    },
    update: async (id: string, name: string, options?: { signal?: AbortSignal }): Promise<Project> => {
      const data = await fetchAPI<ProjectDto>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
        signal: options?.signal,
      })
      return fromProjectDto(data)
    },
    delete: (id: string, options?: { signal?: AbortSignal }) =>
      fetchAPI<void>(`/api/projects/${id}`, { method: 'DELETE', signal: options?.signal }),
  },

  chats: {
    list: async (projectId: string, options?: { signal?: AbortSignal }): Promise<Chat[]> => {
      const data = await fetchAPI<ChatDto[]>(`/api/projects/${projectId}/chats`, {
        signal: options?.signal,
      })
      return data.map(fromChatDto)
    },
    get: async (id: string, options?: { signal?: AbortSignal }): Promise<Chat> => {
      const data = await fetchAPI<ChatDto>(`/api/chats/${id}`, {
        signal: options?.signal,
      })
      return fromChatDto(data)
    },
    create: async (projectId: string, title: string, options?: { signal?: AbortSignal }): Promise<Chat> => {
      const data = await fetchAPI<ChatDto>(`/api/projects/${projectId}/chats`, {
        method: 'POST',
        body: JSON.stringify({ title }),
        signal: options?.signal,
      })
      return fromChatDto(data)
    },
    update: async (id: string, title: string, options?: { signal?: AbortSignal }): Promise<Chat> => {
      const data = await fetchAPI<ChatDto>(`/api/chats/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
        signal: options?.signal,
      })
      return fromChatDto(data)
    },
    delete: (id: string, options?: { signal?: AbortSignal }) =>
      fetchAPI<void>(`/api/chats/${id}`, { method: 'DELETE', signal: options?.signal }),
  },

  messages: {
    list: async (chatId: string, options?: { signal?: AbortSignal }): Promise<Message[]> => {
      const data = await fetchAPI<MessageDto[]>(`/api/chats/${chatId}/messages`, {
        signal: options?.signal,
      })
      return data.map(fromMessageDto)
    },
    send: async (
      chatId: string,
      content: string,
      options?: { signal?: AbortSignal }
    ): Promise<{ userMessage: Message; assistantMessage: Message }> => {
      const data = await fetchAPI<{ user_message: MessageDto; assistant_message: MessageDto }>(
        `/api/chats/${chatId}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ content }),
          signal: options?.signal,
        }
      )
      return {
        userMessage: fromMessageDto(data.user_message),
        assistantMessage: fromMessageDto(data.assistant_message),
      }
    },
  },

  documents: {
    getTree: async (projectId: string, options?: { signal?: AbortSignal }): Promise<DocumentTree> => {
      const data = await fetchAPI<DocumentTreeDto>(`/api/projects/${projectId}/tree`, {
        signal: options?.signal,
      })
      return fromDocumentTreeDto(data)
    },
    get: async (id: string, options?: { signal?: AbortSignal }): Promise<Document> => {
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        signal: options?.signal,
      })
      return fromDocumentDto(data)
    },
    create: async (projectId: string, folderId: string | null, name: string, options?: { signal?: AbortSignal }): Promise<Document> => {
      const data = await fetchAPI<DocumentDto>(`/api/projects/${projectId}/documents`, {
        method: 'POST',
        body: JSON.stringify({ folder_id: folderId, name }),
        signal: options?.signal,
      })
      return fromDocumentDto(data)
    },
    update: async (id: string, content: string, options?: { signal?: AbortSignal }): Promise<Document> => {
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content }),
        signal: options?.signal,
      })
      return fromDocumentDto(data)
    },
    delete: (id: string, options?: { signal?: AbortSignal }) =>
      fetchAPI<void>(`/api/documents/${id}`, { method: 'DELETE', signal: options?.signal }),
  },
}
