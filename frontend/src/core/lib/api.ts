import { Project } from '@/features/projects/types/project'
import { Chat, Turn } from '@/features/chats/types'
import { Document, DocumentTree } from '@/features/documents/types/document'
import {
  ProjectDto,
  ChatDto,
  DocumentDto,
  DocumentTreeDto,
  fromProjectDto,
  fromChatDto,
  fromDocumentDto,
  fromDocumentTreeDto,
  ApiErrorResponse,
} from '@/types/api'
import { httpErrorToAppError } from '@/core/lib/errors'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'
export const API_BASE_URL = API_BASE

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

    // Inject Supabase Auth Token
    const { createClient } = await import('@/core/supabase/client')
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    
    if (session?.access_token) {
      headers.set('Authorization', `Bearer ${session.access_token}`)
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      signal: options?.signal,
      headers,
    })

    if (!response.ok) {
      // Parse RFC 7807 Problem Details response (backend standard)
      let errorMessage = response.statusText
      let resource: T | undefined

      try {
        const errorBody = await response.json()
        // RFC 7807 format: {type, title, status, detail, ...extensions}
        // Fall back to legacy { message | error } if not a problem+json body
        errorMessage = errorBody.detail || errorBody.title || errorBody.message || errorBody.error || errorMessage

        // Preserve resource for 409 Conflict to offer actionable UI (e.g., Open existing)
        if (response.status === 409 && errorBody.resource) {
          resource = errorBody.resource as T
        }
      } catch {
        // JSON parse failed; keep statusText fallback
      }

      // Minimal mapping: status + message (+ optional resource)
      throw httpErrorToAppError(response.status, errorMessage, resource)
    }

    // Handle no content (e.g., 204 No Content from DELETE operations)
    // Type assertion needed: when T is void, TypeScript requires explicit undefined return
    // DELETE endpoints specify fetchAPI<void>() which expects this behavior
    const contentLength = response.headers.get('content-length')
    if (response.status === 204 || contentLength === '0') {
      return undefined as any
    }

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json') || contentType.includes('application/problem+json')) {
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
    // Check for AbortError FIRST before retry logic to prevent race condition:
    // If user switches views/resources, the aborted request should not be retried
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

// Shared types and utilities for Turn API
type TurnBlockDto = {
  id: string
  turn_id: string
  block_type: string
  sequence: number
  text_content?: string | null
  content?: Record<string, unknown> | null
  created_at: string
}

type TurnDto = {
  id: string
  chat_id: string
  prev_turn_id?: string | null
  status: string
  error?: string | null
  model?: string | null
  input_tokens?: number | null
  output_tokens?: number | null
  role: 'user' | 'assistant'
  created_at: string
  completed_at?: string | null
  blocks?: TurnBlockDto[]
  sibling_ids?: string[]
}

/**
 * Converts a backend TurnDto to a frontend Turn model.
 *
 * Pure data transformation - no presentation logic.
 * Use extractTextContent() from turnHelpers for UI-specific text extraction.
 */
function turnDtoToTurn(turn: TurnDto): Turn {
  const blocks = (turn.blocks ?? []).map((b): import('@/features/chats/types').TurnBlock => ({
    id: b.id,
    turnId: b.turn_id,
    blockType: b.block_type,
    sequence: b.sequence,
    textContent: b.text_content ?? undefined,
    content: b.content ?? undefined,
    createdAt: new Date(b.created_at),
  }))

  return {
    id: turn.id,
    chatId: turn.chat_id,
    prevTurnId: turn.prev_turn_id ?? null,
    role: turn.role,
    status: turn.status,
    error: turn.error ?? undefined,
    model: turn.model ?? undefined,
    inputTokens: turn.input_tokens ?? undefined,
    outputTokens: turn.output_tokens ?? undefined,
    createdAt: new Date(turn.created_at),
    completedAt: turn.completed_at ? new Date(turn.completed_at) : undefined,
    blocks,
    siblingIds: turn.sibling_ids ?? [],
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
      const data = await fetchAPI<ChatDto[]>(`/api/chats?project_id=${encodeURIComponent(projectId)}`, {
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
      const data = await fetchAPI<ChatDto>('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, title }),
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

  turns: {
    paginate: async (
      chatId: string,
      options?: {
        fromTurnId?: string
        direction?: 'before' | 'after' | 'both' | ''
        limit?: number
        updateLastViewed?: boolean
        signal?: AbortSignal
      }
    ): Promise<{ turns: Turn[]; hasMoreBefore: boolean; hasMoreAfter: boolean }> => {
      type PaginatedTurnsDto = {
        turns: TurnDto[]
        has_more_before: boolean
        has_more_after: boolean
      }

      const params = new URLSearchParams()
      if (options?.fromTurnId) params.set('from_turn_id', options.fromTurnId)
      if (options?.limit && options.limit > 0) params.set('limit', String(options.limit))
      // Allow empty direction to let server apply defaults; only send if provided non-empty
      if (options?.direction) params.set('direction', options.direction)
      if (options?.updateLastViewed) params.set('update_last_viewed', String(options.updateLastViewed))

      const query = params.toString()
      const endpoint = `/api/chats/${chatId}/turns${query ? `?${query}` : ''}`

      const data = await fetchAPI<PaginatedTurnsDto>(endpoint, { signal: options?.signal })

      return {
        turns: (data.turns ?? []).map(turnDtoToTurn),
        hasMoreBefore: !!data.has_more_before,
        hasMoreAfter: !!data.has_more_after,
      }
    },

    // NOTE: This is a thin adapter on top of the turn-based API.
    // It calls GET /api/chats/:id/turns and maps backend Turn to the frontend Turn type.
    // Wrapper on top of CreateTurn (POST /api/chats/:id/turns).
    // Returns both the created user turn and the assistant turn that will stream.
    send: async (
      chatId: string,
      content: string,
      options?: { prevTurnId?: string | null; signal?: AbortSignal }
    ): Promise<{ userTurn: Turn; assistantTurn: Turn; streamUrl: string }> => {
      const response = await fetchAPI<{
        user_turn: TurnDto
        assistant_turn: TurnDto
        stream_url: string
      }>(
        `/api/chats/${chatId}/turns`,
        {
          method: 'POST',
          body: JSON.stringify({
            role: 'user',
            turn_blocks: [
              {
                block_type: 'text',
                text_content: content,
                content: null,
              },
            ],
            prev_turn_id: options?.prevTurnId ?? null,
            request_params: {},
          }),
          signal: options?.signal,
        }
      )
      return {
        userTurn: turnDtoToTurn(response.user_turn),
        assistantTurn: turnDtoToTurn(response.assistant_turn),
        streamUrl: response.stream_url,
      }
    },

    getBranch: async (chatId: string, turnId: string, options?: { signal?: AbortSignal }): Promise<Turn[]> => {
      const data = await fetchAPI<TurnDto[]>(`/api/turns/${turnId}/path`, {
        signal: options?.signal,
      })
      return (data ?? []).map(turnDtoToTurn)
    },

    getSiblings: async (turnId: string, options?: { signal?: AbortSignal }): Promise<string[]> => {
      const data = await fetchAPI<TurnDto[]>(`/api/turns/${turnId}/siblings`, {
        signal: options?.signal,
      })
      return (data ?? []).map((t) => t.id)
    },

    getContinuation: async (chatId: string, fromTurnId: string, options?: { signal?: AbortSignal }): Promise<Turn[]> => {
      type PaginatedTurnsDto = {
        turns: TurnDto[]
      }
      const data = await fetchAPI<PaginatedTurnsDto>(
        `/api/chats/${chatId}/turns?from_turn_id=${fromTurnId}&limit=100&direction=after`,
        { signal: options?.signal }
      )
      return (data.turns ?? []).map(turnDtoToTurn)
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
