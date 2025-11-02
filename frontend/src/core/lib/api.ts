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
  APIError,
} from '@/types/api'
import { httpErrorToAppError } from '@/core/lib/errors'

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

  chats: {
    list: async (projectId: string): Promise<Chat[]> => {
      const data = await fetchAPI<ChatDto[]>(`/api/projects/${projectId}/chats`)
      return data.map(fromChatDto)
    },
    get: async (id: string): Promise<Chat> => {
      const data = await fetchAPI<ChatDto>(`/api/chats/${id}`)
      return fromChatDto(data)
    },
    create: async (projectId: string, title: string): Promise<Chat> => {
      const data = await fetchAPI<ChatDto>(`/api/projects/${projectId}/chats`, {
        method: 'POST',
        body: JSON.stringify({ title }),
      })
      return fromChatDto(data)
    },
    update: async (id: string, title: string): Promise<Chat> => {
      const data = await fetchAPI<ChatDto>(`/api/chats/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      })
      return fromChatDto(data)
    },
    delete: (id: string) =>
      fetchAPI<void>(`/api/chats/${id}`, { method: 'DELETE' }),
  },

  messages: {
    list: async (chatId: string): Promise<Message[]> => {
      const data = await fetchAPI<MessageDto[]>(`/api/chats/${chatId}/messages`)
      return data.map(fromMessageDto)
    },
    send: async (
      chatId: string,
      content: string
    ): Promise<{ userMessage: Message; assistantMessage: Message }> => {
      const data = await fetchAPI<{ user_message: MessageDto; assistant_message: MessageDto }>(
        `/api/chats/${chatId}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ content }),
        }
      )
      return {
        userMessage: fromMessageDto(data.user_message),
        assistantMessage: fromMessageDto(data.assistant_message),
      }
    },
  },

  documents: {
    getTree: async (projectId: string): Promise<DocumentTree> => {
      const data = await fetchAPI<DocumentTreeDto>(`/api/projects/${projectId}/documents/tree`)
      return fromDocumentTreeDto(data)
    },
    get: async (id: string): Promise<Document> => {
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`)
      return fromDocumentDto(data)
    },
    create: async (projectId: string, folderId: string | null, name: string): Promise<Document> => {
      const data = await fetchAPI<DocumentDto>(`/api/projects/${projectId}/documents`, {
        method: 'POST',
        body: JSON.stringify({ folder_id: folderId, name }),
      })
      return fromDocumentDto(data)
    },
    update: async (id: string, content: string): Promise<Document> => {
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content }),
      })
      return fromDocumentDto(data)
    },
    delete: (id: string) =>
      fetchAPI<void>(`/api/documents/${id}`, { method: 'DELETE' }),
  },
}
