import { Project } from '@/features/projects/types/project'
import { Chat, Turn, type ChatRequestOptions, DEFAULT_CHAT_REQUEST_OPTIONS } from '@/features/chats/types'
import { Document, DocumentTree } from '@/features/documents/types/document'
import { Folder } from '@/features/folders/types/folder'
import {
  ProjectDto,
  ChatDto,
  DocumentDto,
  DocumentTreeDto,
  FolderDto,
  fromProjectDto,
  fromChatDto,
  fromDocumentDto,
  fromDocumentTreeDto,
  fromFolderDto,
} from '@/types/api'
import { httpErrorToAppError } from '@/core/lib/errors'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'
export const API_BASE_URL = API_BASE

/**
 * Handles 401 Unauthorized errors by attempting session refresh.
 * If refresh fails, redirects to root (middleware will then redirect to /login).
 * @returns true if session was refreshed successfully (caller should retry request)
 */
async function handleUnauthorized(): Promise<boolean> {
  const { createClient } = await import('@/core/supabase/client')
  const supabase = createClient()

  // Attempt to refresh the session
  const { data, error } = await supabase.auth.refreshSession()

  if (error || !data.session) {
    // Refresh failed - redirect to root
    // Middleware will detect no session and redirect to /login
    if (typeof window !== 'undefined') {
      window.location.href = '/'
    }
    return false
  }

  // Refresh succeeded - caller should retry the request with new token
  return true
}

export async function fetchAPI<T>(
  endpoint: string,
  options?: RequestInit & { signal?: AbortSignal }
): Promise<T> {
  const method = (options?.method || 'GET').toUpperCase()

  const attempt = async (hasTriedRefresh = false): Promise<T> => {
    // Build headers robustly (HeadersInit union): preserve caller headers
    const headers = new Headers(options?.headers as HeadersInit | undefined)
    // Only set Content-Type for JSON - FormData sets its own with boundary
    if (options?.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
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

      // Handle 401 Unauthorized - attempt session refresh once
      if (response.status === 401 && !hasTriedRefresh) {
        const refreshed = await handleUnauthorized()
        if (refreshed) {
          // Session refreshed successfully - retry request with new token
          return await attempt(true)
        }
        // Refresh failed - handleUnauthorized() already redirected to /
        // Fall through to throw error for proper cleanup
      }

      // Minimal mapping: status + message (+ optional resource)
      throw httpErrorToAppError(response.status, errorMessage, resource)
    }

    // Handle no content (e.g., 204 No Content from DELETE operations)
    // Type assertion needed: when T is void, TypeScript requires explicit undefined return
    // DELETE endpoints specify fetchAPI<void>() which expects this behavior
    const contentLength = response.headers.get('content-length')
    if (response.status === 204 || contentLength === '0') {
      return undefined as T
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

    if (err && typeof err === 'object') {
      const errorWithMeta = err as { name?: string; type?: string }
      if (errorWithMeta.name === 'AppError') {
        const t = errorWithMeta.type
        if (t === 'SERVER_ERROR' || t === 'UNKNOWN_ERROR') return true
      }
    }

    return false
  }

  try {
    return await attempt(false)
  } catch (error) {
    // Check for AbortError FIRST before retry logic to prevent race condition:
    // If user switches views/resources, the aborted request should not be retried
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }

    if (shouldRetry(error)) {
      await new Promise((r) => setTimeout(r, 200))
      return await attempt(false)
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
    blockType: b.block_type as import('@/features/chats/types').BlockType,
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

// Model capabilities (used for chat model selection)
type ModelCapabilityDto = {
  id: string
  display_name: string
  context_window: number
  capabilities: {
    tool_calls?: string
    image_input?: boolean
    image_generation?: boolean
    streaming?: boolean
    thinking?: boolean
    [key: string]: unknown
  }
  pricing?: {
    input_per_1m?: number
    output_per_1m?: number
    [key: string]: unknown
  }
}

type ModelProviderDto = {
  id: string
  name: string
  models: ModelCapabilityDto[]
}

export type ModelCapabilitiesProvider = {
  id: string
  name: string
  models: {
    id: string
    displayName: string
    contextWindow: number
    supportsThinking: boolean
  }[]
}

export interface ImportResponse {
  success: boolean
  summary: {
    created: number
    updated: number
    skipped: number
    failed: number
    total_files: number
  }
  errors: Array<{ file: string; error: string }>
  documents: Array<{ id: string; path: string; name: string; action: string }>
}

type SendTurnOptions = {
  prevTurnId?: string | null
  signal?: AbortSignal
  requestOptions?: ChatRequestOptions
}

function buildRequestParamsFromChatOptions(
  options?: ChatRequestOptions
): Record<string, unknown> {
  const resolved = options ?? DEFAULT_CHAT_REQUEST_OPTIONS

  const requestParams: Record<string, unknown> = {
    model: resolved.modelId,
    provider: resolved.providerId,
    // NOTE: max_tokens and lorem_max are left to backend defaults for now.
    thinking_enabled: true,
    thinking_level: resolved.reasoning,
  }

  const tools: Array<Record<string, string>> = [
    { name: 'doc_view' },
    { name: 'doc_search' },
    { name: 'doc_tree' },
  ]

  // TODO: Move web search to a persistent hidden setting (not per-message toggle)
  // Using custom Tavily search (server-side) instead of Claude's built-in
  if (resolved.searchEnabled) {
    tools.push({ name: 'tavily_web_search' })
  }

  requestParams.tools = tools
  return requestParams
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

  models: {
    getCapabilities: async (options?: {
      signal?: AbortSignal
    }): Promise<ModelCapabilitiesProvider[]> => {
      type ResponseDto = { providers: ModelProviderDto[] }

      const data = await fetchAPI<ResponseDto>('/api/models/capabilities', {
        signal: options?.signal,
      })

      const providers = data.providers ?? []

      return providers.map((provider): ModelCapabilitiesProvider => ({
        id: provider.id,
        name: provider.name,
        models: (provider.models ?? []).map((model) => ({
          id: model.id,
          displayName: model.display_name,
          contextWindow: model.context_window,
          supportsThinking: !!model.capabilities?.thinking,
        })),
      }))
    },
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
    updateLastViewedTurn: async (chatId: string, turnId: string, options?: { signal?: AbortSignal }): Promise<void> => {
      await fetchAPI<void>(`/api/chats/${chatId}/last-viewed-turn`, {
        method: 'PATCH',
        body: JSON.stringify({ turn_id: turnId }),
        signal: options?.signal,
      })
    },
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
      message: string,
      options?: SendTurnOptions
    ): Promise<{ userTurn: Turn; assistantTurn: Turn; streamUrl: string }> => {
      const requestParams = buildRequestParamsFromChatOptions(options?.requestOptions)

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
                text_content: message,
                content: null,
              },
            ],
            prev_turn_id: options?.prevTurnId ?? null,
            request_params: requestParams,
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

    getBlocks: async (turnId: string, options?: { signal?: AbortSignal }): Promise<import('@/features/chats/types').TurnBlock[]> => {
      type GetTurnBlocksResponseDto = {
        turn_id: string
        status: string
        error?: string | null
        blocks: TurnBlockDto[]
      }
      const data = await fetchAPI<GetTurnBlocksResponseDto>(`/api/turns/${turnId}/blocks`, {
        signal: options?.signal,
      })
      return (data.blocks ?? []).map((b) => ({
        id: b.id,
        turnId: b.turn_id,
        blockType: b.block_type as import('@/features/chats/types').BlockType,
        sequence: b.sequence,
        textContent: b.text_content ?? undefined,
        content: b.content ?? undefined,
        createdAt: new Date(b.created_at),
      }))
    },

    interrupt: async (turnId: string, options?: { signal?: AbortSignal }): Promise<void> => {
      await fetchAPI<void>(`/api/turns/${turnId}/interrupt`, {
        method: 'POST',
        signal: options?.signal,
      })
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
      const data = await fetchAPI<DocumentDto>('/api/documents', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, folder_id: folderId, name }),
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
    rename: async (id: string, projectId: string, name: string, options?: { signal?: AbortSignal }): Promise<Document> => {
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ project_id: projectId, name }),
        signal: options?.signal,
      })
      return fromDocumentDto(data)
    },
    delete: (id: string, options?: { signal?: AbortSignal }) =>
      fetchAPI<void>(`/api/documents/${id}`, { method: 'DELETE', signal: options?.signal }),
    import: async (
      projectId: string,
      files: File[],
      folderId?: string | null,
      options?: { signal?: AbortSignal; overwrite?: boolean }
    ): Promise<ImportResponse> => {
      const formData = new FormData()
      // Append all files with the same 'files' key (multipart standard for multiple files)
      files.forEach((file) => {
        formData.append('files', file)
      })

      let url = `/api/import?project_id=${encodeURIComponent(projectId)}`
      if (folderId) {
        url += `&folder_id=${encodeURIComponent(folderId)}`
      }
      if (options?.overwrite) {
        url += '&overwrite=true'
      }

      const data = await fetchAPI<ImportResponse>(url, {
        method: 'POST',
        body: formData,
        signal: options?.signal,
      })
      return data
    },
  },

  folders: {
    create: async (projectId: string, parentId: string | null, name: string, options?: { signal?: AbortSignal }): Promise<Folder> => {
      const data = await fetchAPI<FolderDto>('/api/folders', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, folder_id: parentId, name }),
        signal: options?.signal,
      })
      return fromFolderDto(data)
    },
    rename: async (id: string, projectId: string, name: string, options?: { signal?: AbortSignal }): Promise<Folder> => {
      const data = await fetchAPI<FolderDto>(`/api/folders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ project_id: projectId, name }),
        signal: options?.signal,
      })
      return fromFolderDto(data)
    },
    delete: (id: string, options?: { signal?: AbortSignal }) =>
      fetchAPI<void>(`/api/folders/${id}`, { method: 'DELETE', signal: options?.signal }),
  },
}
