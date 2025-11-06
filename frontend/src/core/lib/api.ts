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
  const method = (options?.method || 'GET').toUpperCase()

  const attempt = async (): Promise<T> => {
    // Build headers robustly (HeadersInit union): preserve caller headers
    const headers = new Headers(options?.headers as HeadersInit | undefined)
    if (options?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
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
        // ignore
      }
      throw httpErrorToAppError(response.status, errorMessage)
    }

    // Handle no content
    const contentLength = response.headers.get('content-length')
    if (response.status === 204 || contentLength === '0') {
      return undefined as any
    }

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const raw = await response.text()
      try {
        return JSON.parse(raw) as T
      } catch (e) {
        const { ErrorType, AppError } = await import('./errors')
        const snippet = raw ? raw.slice(0, 180) : ''
        throw new AppError(
          ErrorType.ServerError,
          `Invalid JSON from ${endpoint}: ${(e as Error).message}${snippet ? `; body: ${snippet}` : ''}`
        )
      }
    }

    // Non-JSON success — surface a clearer error
    const bodyText = await response.text().catch(() => '')
    const { ErrorType, AppError } = await import('./errors')
    const snippet = bodyText ? `; body: ${bodyText.slice(0, 180)}` : ''
    throw new AppError(
      ErrorType.ServerError,
      `Invalid response from server for ${endpoint}: expected application/json but got "${contentType || 'unknown'}"${snippet}`
    )
  }

  // One-shot retry for GET on network/parse errors (transient)
  const shouldRetry = (err: unknown) => {
    if (method !== 'GET') return false
    if (err instanceof TypeError) return true
    if (err && (err as any).name === 'AppError') {
      const t = (err as any).type
      if (t === 'SERVER_ERROR' || t === 'UNKNOWN_ERROR') return true
    }
    return false
  }

  try {
    return await attempt()
  } catch (error) {
    // Check for AbortError FIRST before retry logic to avoid retrying aborted requests
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }

    if (shouldRetry(error)) {
      await new Promise((r) => setTimeout(r, 200))
      return await attempt()
    }

    // If it's already an AppError, rethrow as-is
    if (error instanceof Error && error.constructor.name === 'AppError') {
      throw error
    }

    if (error instanceof TypeError) {
      const { ErrorType, AppError } = await import('./errors')
      throw new AppError(
        ErrorType.Network,
        'Network error: Unable to connect to server. Please check your connection.'
      )
    }

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
    rename: async (id: string, name: string, options?: { signal?: AbortSignal }): Promise<Document> => {
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
        signal: options?.signal,
      })
      return fromDocumentDto(data)
    },
    delete: (id: string, options?: { signal?: AbortSignal }) =>
      fetchAPI<void>(`/api/documents/${id}`, { method: 'DELETE', signal: options?.signal }),
  },
}
