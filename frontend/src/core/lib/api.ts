import { Project } from "@/features/projects/types/project";
import {
  Thread,
  Turn,
  type ThreadRequestOptions,
  type ContentBlock,
  DEFAULT_THREAD_REQUEST_OPTIONS,
} from "@/features/threads/types";
import { Document, DocumentTree } from "@/features/documents/types/document";
import { Folder } from "@/features/folders/types/folder";
import {
  ProjectDto,
  ThreadDto,
  DocumentDto,
  DocumentTreeDto,
  FolderDto,
  SkillDto,
  SkillWithContentDto,
  SkillListResponseDto,
  fromProjectDto,
  fromThreadDto,
  fromDocumentDto,
  fromDocumentTreeDto,
  fromFolderDto,
  fromSkillDto,
  fromSkillWithContentDto,
} from "@/types/api";
import type {
  Skill,
  SkillWithContent,
  CreateSkillRequest,
  UpdateSkillRequest,
} from "@/features/skills/types/skill";
import { httpErrorToAppError } from "@/core/lib/errors";
import { convertKeysToCamelCase } from "./caseConvert";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8080";
export const API_BASE_URL = API_BASE;

// Guard against concurrent 401 handling (multiple requests failing simultaneously)
let isHandlingUnauthorized = false;

/**
 * Handles 401 Unauthorized errors by attempting session refresh.
 * If refresh fails, shows SessionExpiredModal (user must sign in again).
 * @returns true if session was refreshed successfully (caller should retry request)
 */
async function handleUnauthorized(): Promise<boolean> {
  // Prevent concurrent refresh attempts - only the first caller handles it
  if (isHandlingUnauthorized) return false;
  isHandlingUnauthorized = true;

  try {
    const { createClient } = await import("@/core/supabase/client");
    const supabase = createClient();

    // Attempt to refresh the session
    const { data, error } = await supabase.auth.refreshSession();

    if (error || !data.session) {
      // Refresh failed - show session expired modal
      // User must sign in again to continue
      const { useErrorStore } = await import("@/core/stores/useErrorStore");
      useErrorStore.getState().setSessionExpired(true);
      return false;
    }

    // Refresh succeeded - caller should retry the request with new token
    return true;
  } finally {
    isHandlingUnauthorized = false;
  }
}

export async function fetchAPI<T>(
  endpoint: string,
  options?: RequestInit & { signal?: AbortSignal },
): Promise<T> {
  const method = (options?.method || "GET").toUpperCase();

  const attempt = async (hasTriedRefresh = false): Promise<T> => {
    // Build headers robustly (HeadersInit union): preserve caller headers
    const headers = new Headers(options?.headers as HeadersInit | undefined);
    // Only set Content-Type for JSON - FormData sets its own with boundary
    if (
      options?.body &&
      !(options.body instanceof FormData) &&
      !headers.has("Content-Type")
    ) {
      headers.set("Content-Type", "application/json");
    }

    // Inject Supabase Auth Token
    const { createClient } = await import("@/core/supabase/client");
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.access_token) {
      headers.set("Authorization", `Bearer ${session.access_token}`);
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      signal: options?.signal,
      headers,
    });

    if (!response.ok) {
      // Parse RFC 7807 Problem Details response (backend standard)
      let errorMessage = response.statusText;
      let resource: T | undefined;
      let field: string | undefined;

      try {
        const errorBody = await response.json();
        // RFC 7807 format: {type, title, status, detail, ...extensions}
        // Fall back to legacy { message | error } if not a problem+json body
        errorMessage =
          errorBody.detail ||
          errorBody.title ||
          errorBody.message ||
          errorBody.error ||
          errorMessage;

        // Preserve resource for 409 Conflict to offer actionable UI (e.g., Open existing)
        if (response.status === 409 && errorBody.resource) {
          resource = errorBody.resource as T;
        }

        // Extract field hint for validation errors (backend ValidationError.Field)
        if (response.status === 400 && errorBody.field) {
          field = errorBody.field as string;
        }
      } catch {
        // JSON parse failed; keep statusText fallback
      }

      // Handle 401 Unauthorized - attempt session refresh once
      if (response.status === 401 && !hasTriedRefresh) {
        const refreshed = await handleUnauthorized();
        if (refreshed) {
          // Session refreshed successfully - retry request with new token
          return await attempt(true);
        }
        // Refresh failed - handleUnauthorized() already redirected to /
        // Fall through to throw error for proper cleanup
      }

      // Minimal mapping: status + message (+ optional resource/field)
      throw httpErrorToAppError(
        response.status,
        errorMessage,
        resource,
        undefined,
        field,
      );
    }

    // Handle no content (e.g., 204 No Content from DELETE operations)
    // Type assertion needed: when T is void, TypeScript requires explicit undefined return
    // DELETE endpoints specify fetchAPI<void>() which expects this behavior
    const contentLength = response.headers.get("content-length");
    if (response.status === 204 || contentLength === "0") {
      return undefined as T;
    }

    const contentType = response.headers.get("content-type") || "";
    if (
      contentType.includes("application/json") ||
      contentType.includes("application/problem+json")
    ) {
      const raw = await response.text();
      try {
        const parsed = JSON.parse(raw);
        // Convert snake_case keys to camelCase (backend uses snake_case, frontend uses camelCase)
        return convertKeysToCamelCase(parsed) as T;
      } catch (e) {
        const { ErrorType, AppError } = await import("./errors");
        const snippet = raw ? raw.slice(0, 180) : "";
        throw new AppError(
          ErrorType.ServerError,
          `Invalid JSON from ${endpoint}: ${(e as Error).message}${snippet ? `; body: ${snippet}` : ""}`,
        );
      }
    }

    // Non-JSON success — surface a clearer error
    const bodyText = await response.text().catch(() => "");
    const { ErrorType, AppError } = await import("./errors");
    const snippet = bodyText ? `; body: ${bodyText.slice(0, 180)}` : "";
    throw new AppError(
      ErrorType.ServerError,
      `Invalid response from server for ${endpoint}: expected application/json but got "${contentType || "unknown"}"${snippet}`,
    );
  };

  // One-shot retry for GET on network/parse errors (transient)
  const shouldRetry = (err: unknown) => {
    if (method !== "GET") return false;
    if (err instanceof TypeError) return true;

    if (err && typeof err === "object") {
      const errorWithMeta = err as { name?: string; type?: string };
      if (errorWithMeta.name === "AppError") {
        const t = errorWithMeta.type;
        if (t === "SERVER_ERROR" || t === "UNKNOWN_ERROR") return true;
      }
    }

    return false;
  };

  try {
    return await attempt(false);
  } catch (error) {
    // Check for AbortError FIRST before retry logic to prevent race condition:
    // If user switches views/resources, the aborted request should not be retried
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }

    if (shouldRetry(error)) {
      await new Promise((r) => setTimeout(r, 200));
      return await attempt(false);
    }

    // If it's already an AppError, rethrow as-is
    if (error instanceof Error && error.constructor.name === "AppError") {
      throw error;
    }

    if (error instanceof TypeError) {
      const { ErrorType, AppError } = await import("./errors");
      throw new AppError(
        ErrorType.Network,
        "Network error: Unable to connect to server. Please check your connection.",
      );
    }

    const { ErrorType, AppError } = await import("./errors");
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred";
    throw new AppError(ErrorType.Unknown, message);
  }
}

// Shared types and utilities for Turn API
// NOTE: These types use camelCase because fetchAPI auto-converts snake_case from backend
// Exported for SSE gateway layer to reuse (SSE also receives camelCase after parsing)
export type TurnBlockDto = {
  id: string;
  turnId: string;
  blockType: string;
  sequence: number;
  textContent?: string | null;
  content?: Record<string, unknown> | null;
  createdAt: string;
};

export type TurnDto = {
  id: string;
  threadId: string;
  prevTurnId?: string | null;
  status: string;
  error?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  role: "user" | "assistant";
  createdAt: string;
  completedAt?: string | null;
  blocks?: TurnBlockDto[];
  siblingIds?: string[];
  requestParams?: Record<string, unknown> | null;
  responseMetadata?: Record<string, unknown> | null;
};

/**
 * Converts a backend TurnDto to a frontend Turn model.
 *
 * Pure data transformation - no presentation logic.
 * Use extractTextContent() from turnHelpers for UI-specific text extraction.
 *
 * NOTE: TurnDto is already camelCase (auto-converted by fetchAPI gateway or SSE parser).
 * This function mainly handles Date conversions.
 *
 * Exported for SSE gateway layer to reuse - SSE events also need date conversion.
 */
export function turnDtoToTurn(turn: TurnDto): Turn {
  const blocks = (turn.blocks ?? []).map(
    (b): import("@/features/threads/types").TurnBlock => ({
      id: b.id,
      turnId: b.turnId,
      blockType: b.blockType as import("@/features/threads/types").BlockType,
      sequence: b.sequence,
      textContent: b.textContent ?? undefined,
      content: b.content ?? undefined,
      createdAt: new Date(b.createdAt),
    }),
  );

  return {
    id: turn.id,
    threadId: turn.threadId,
    prevTurnId: turn.prevTurnId ?? null,
    role: turn.role,
    status: turn.status,
    error: turn.error ?? undefined,
    model: turn.model ?? undefined,
    inputTokens: turn.inputTokens ?? undefined,
    outputTokens: turn.outputTokens ?? undefined,
    createdAt: new Date(turn.createdAt),
    completedAt: turn.completedAt ? new Date(turn.completedAt) : undefined,
    blocks,
    siblingIds: turn.siblingIds ?? [],
    requestParams: turn.requestParams as
      | import("@/features/threads/types").RequestParams
      | undefined,
    responseMetadata: turn.responseMetadata as
      | Record<string, unknown>
      | undefined,
  };
}

// Model capabilities (used for thread model selection)
// NOTE: These types use camelCase because fetchAPI auto-converts snake_case from backend
type ModelCapabilityDto = {
  id: string;
  displayName: string;
  contextWindow: number;
  capabilities: {
    supportsTools?: boolean;
    toolCalls?: string;
    imageInput?: boolean;
    imageGeneration?: boolean;
    streaming?: boolean;
    thinking?: boolean;
    requiresThinking?: boolean;
    [key: string]: unknown;
  };
  pricing?: {
    inputPer1m?: number;
    outputPer1m?: number;
    [key: string]: unknown;
  };
};

type ModelProviderDto = {
  id: string;
  name: string;
  models: ModelCapabilityDto[];
};

export type ModelCapabilitiesProvider = {
  id: string;
  name: string;
  models: {
    id: string;
    displayName: string;
    contextWindow: number;
    supportsThinking: boolean;
    requiresThinking: boolean;
    supportsTools: boolean;
  }[];
};

// NOTE: Uses camelCase because fetchAPI auto-converts snake_case from backend
export interface ImportResponse {
  success: boolean;
  summary: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    totalFiles: number;
  };
  errors: Array<{ file: string; error: string }>;
  documents: Array<{ id: string; path: string; name: string; action: string }>;
}

/**
 * Lightweight AI status response for efficient polling (~100 bytes vs ~50KB full document).
 * Backend: GET /api/documents/{id}/ai-status
 */
export interface AIStatusResponse {
  hasAiVersion: boolean;
  aiVersionRev: number | null;
}

type SendTurnOptions = {
  threadId?: string; // Optional - if not provided with projectId, creates new thread
  projectId?: string; // Required if threadId is not provided (for cold start)
  prevTurnId?: string | null;
  signal?: AbortSignal;
  requestOptions?: ThreadRequestOptions;
  /** Ordered content blocks — preserves text/reference interleaving */
  blocks?: ContentBlock[];
  /** @deprecated Use blocks instead. Kept for backward compatibility. */
  references?: Array<{ documentId: string; refType: string }>;
};

function buildRequestParamsFromThreadOptions(
  options?: ThreadRequestOptions,
): Record<string, unknown> {
  const resolved = options ?? DEFAULT_THREAD_REQUEST_OPTIONS;

  console.debug("[buildRequestParamsFromThreadOptions]", {
    supportsTools: resolved.supportsTools,
  });

  // When reasoning is 'off', disable thinking entirely
  // Otherwise, enable thinking with the specified level
  const thinkingEnabled = resolved.reasoning !== "off";

  const requestParams: Record<string, unknown> = {
    model: resolved.modelId,
    provider: resolved.providerId,
    // NOTE: max_tokens and lorem_max are left to backend defaults for now.
    thinking_enabled: thinkingEnabled,
    thinking_level: thinkingEnabled ? resolved.reasoning : null,
  };

  return requestParams;
}

export const api = {
  projects: {
    list: async (options?: { signal?: AbortSignal }): Promise<Project[]> => {
      const data = await fetchAPI<ProjectDto[]>("/api/projects", {
        signal: options?.signal,
      });
      return data.map(fromProjectDto);
    },
    get: async (
      id: string,
      options?: { signal?: AbortSignal },
    ): Promise<Project> => {
      const data = await fetchAPI<ProjectDto>(`/api/projects/${id}`, {
        signal: options?.signal,
      });
      return fromProjectDto(data);
    },
    create: async (
      name: string,
      options?: { signal?: AbortSignal },
    ): Promise<Project> => {
      const data = await fetchAPI<ProjectDto>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
        signal: options?.signal,
      });
      return fromProjectDto(data);
    },
    update: async (
      id: string,
      updates: {
        name?: string;
        systemPrompt?: string | null;
        preferences?: { disabledTools?: string[] };
      },
      options?: { signal?: AbortSignal },
    ): Promise<Project> => {
      // Build request body, mapping to snake_case for API
      const body: Record<string, unknown> = {};
      if (updates.name !== undefined) body.name = updates.name;
      if (updates.systemPrompt !== undefined)
        body.system_prompt = updates.systemPrompt;
      if (updates.preferences !== undefined) {
        body.preferences = {
          disabled_tools: updates.preferences.disabledTools,
        };
      }

      const data = await fetchAPI<ProjectDto>(`/api/projects/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      return fromProjectDto(data);
    },
    delete: (id: string, options?: { signal?: AbortSignal }) =>
      fetchAPI<void>(`/api/projects/${id}`, {
        method: "DELETE",
        signal: options?.signal,
      }),
    addFavorite: async (
      id: string,
      options?: { signal?: AbortSignal },
    ): Promise<Project> => {
      const data = await fetchAPI<ProjectDto>(`/api/projects/${id}/favorite`, {
        method: "POST",
        signal: options?.signal,
      });
      return fromProjectDto(data);
    },
    removeFavorite: async (
      id: string,
      options?: { signal?: AbortSignal },
    ): Promise<Project> => {
      const data = await fetchAPI<ProjectDto>(`/api/projects/${id}/favorite`, {
        method: "DELETE",
        signal: options?.signal,
      });
      return fromProjectDto(data);
    },
  },

  models: {
    getCapabilities: async (options?: {
      signal?: AbortSignal;
    }): Promise<ModelCapabilitiesProvider[]> => {
      type ResponseDto = { providers: ModelProviderDto[] };

      const data = await fetchAPI<ResponseDto>("/api/models/capabilities", {
        signal: options?.signal,
      });

      const providers = data.providers ?? [];

      return providers.map(
        (provider): ModelCapabilitiesProvider => ({
          id: provider.id,
          name: provider.name,
          models: (provider.models ?? []).map((model) => ({
            id: model.id,
            displayName: model.displayName,
            contextWindow: model.contextWindow,
            supportsThinking: !!model.capabilities?.thinking,
            requiresThinking: !!model.capabilities?.requiresThinking,
            supportsTools: model.capabilities?.supportsTools !== false,
          })),
        }),
      );
    },
  },

  threads: {
    list: async (
      projectId: string,
      options?: { signal?: AbortSignal },
    ): Promise<Thread[]> => {
      const data = await fetchAPI<ThreadDto[]>(
        `/api/threads?project_id=${encodeURIComponent(projectId)}`,
        {
          signal: options?.signal,
        },
      );
      return data.map(fromThreadDto);
    },
    get: async (
      id: string,
      options?: { signal?: AbortSignal },
    ): Promise<Thread> => {
      const data = await fetchAPI<ThreadDto>(`/api/threads/${id}`, {
        signal: options?.signal,
      });
      return fromThreadDto(data);
    },
    create: async (
      projectId: string,
      title: string,
      options?: { signal?: AbortSignal },
    ): Promise<Thread> => {
      const data = await fetchAPI<ThreadDto>("/api/threads", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, title }),
        signal: options?.signal,
      });
      return fromThreadDto(data);
    },
    update: async (
      id: string,
      title: string,
      options?: { signal?: AbortSignal },
    ): Promise<Thread> => {
      const data = await fetchAPI<ThreadDto>(`/api/threads/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
        signal: options?.signal,
      });
      return fromThreadDto(data);
    },
    delete: (id: string, options?: { signal?: AbortSignal }) =>
      fetchAPI<void>(`/api/threads/${id}`, {
        method: "DELETE",
        signal: options?.signal,
      }),
    updateLastViewedTurn: async (
      threadId: string,
      turnId: string,
      options?: { signal?: AbortSignal },
    ): Promise<void> => {
      await fetchAPI<void>(`/api/threads/${threadId}/last-viewed-turn`, {
        method: "PATCH",
        body: JSON.stringify({ turn_id: turnId }),
        signal: options?.signal,
      });
    },
  },

  turns: {
    paginate: async (
      threadId: string,
      options?: {
        fromTurnId?: string;
        direction?: "before" | "after" | "both" | "";
        limit?: number;
        updateLastViewed?: boolean;
        signal?: AbortSignal;
      },
    ): Promise<{
      turns: Turn[];
      hasMoreBefore: boolean;
      hasMoreAfter: boolean;
    }> => {
      // NOTE: Uses camelCase because fetchAPI auto-converts snake_case from backend
      type PaginatedTurnsDto = {
        turns: TurnDto[];
        hasMoreBefore: boolean;
        hasMoreAfter: boolean;
      };

      const params = new URLSearchParams();
      if (options?.fromTurnId) params.set("from_turn_id", options.fromTurnId);
      if (options?.limit && options.limit > 0)
        params.set("limit", String(options.limit));
      // Allow empty direction to let server apply defaults; only send if provided non-empty
      if (options?.direction) params.set("direction", options.direction);
      if (options?.updateLastViewed)
        params.set("update_last_viewed", String(options.updateLastViewed));

      const query = params.toString();
      const endpoint = `/api/threads/${threadId}/turns${query ? `?${query}` : ""}`;

      const data = await fetchAPI<PaginatedTurnsDto>(endpoint, {
        signal: options?.signal,
      });

      return {
        turns: (data.turns ?? []).map(turnDtoToTurn),
        hasMoreBefore: !!data.hasMoreBefore,
        hasMoreAfter: !!data.hasMoreAfter,
      };
    },

    // Send a message to create a new turn.
    // Uses POST /api/turns with thread resolution:
    // 1. If prevTurnId provided → infer thread from that turn
    // 2. Else if threadId provided → use that thread
    // 3. Else if projectId provided → create new thread (cold start)
    //
    // Returns the created turns and optionally the new thread if cold start.
    send: async (
      message: string,
      options: SendTurnOptions,
    ): Promise<import("@/features/threads/types").SendTurnResponse> => {
      const requestParams = buildRequestParamsFromThreadOptions(
        options?.requestOptions,
      );

      // Serialize content blocks in order — preserves text/reference interleaving.
      // Falls back to legacy message + references if blocks not provided.
      let turnBlocks: Array<Record<string, unknown>>;
      if (options.blocks && options.blocks.length > 0) {
        turnBlocks = options.blocks.map((block) => {
          if (block.type === "text") {
            return {
              block_type: "text",
              text_content: block.text,
              content: null,
            };
          }
          // block.type === "reference"
          return {
            block_type: "reference",
            text_content: null,
            content: { ref_id: block.documentId, ref_type: block.refType },
          };
        });
      } else {
        // Legacy path: single text block + appended references
        turnBlocks = [
          {
            block_type: "text",
            text_content: message,
            content: null,
          },
          ...(options.references ?? []).map((ref) => ({
            block_type: "reference",
            text_content: null,
            content: { ref_id: ref.documentId, ref_type: ref.refType },
          })),
        ];
      }

      // NOTE: Response uses camelCase because fetchAPI auto-converts snake_case from backend
      const response = await fetchAPI<{
        thread?: ThreadDto; // Only present on cold start
        userTurn: TurnDto;
        assistantTurn: TurnDto;
        streamUrl: string;
      }>("/api/turns", {
        method: "POST",
        body: JSON.stringify({
          thread_id: options.threadId ?? null,
          project_id: options.projectId ?? null,
          role: "user",
          turn_blocks: turnBlocks,
          prev_turn_id: options?.prevTurnId ?? null,
          request_params: requestParams,
        }),
        signal: options?.signal,
      });
      return {
        thread: response.thread ? fromThreadDto(response.thread) : undefined,
        userTurn: turnDtoToTurn(response.userTurn),
        assistantTurn: turnDtoToTurn(response.assistantTurn),
        streamUrl: response.streamUrl,
      };
    },

    getBranch: async (
      threadId: string,
      turnId: string,
      options?: { signal?: AbortSignal },
    ): Promise<Turn[]> => {
      const data = await fetchAPI<TurnDto[]>(`/api/turns/${turnId}/path`, {
        signal: options?.signal,
      });
      return (data ?? []).map(turnDtoToTurn);
    },

    getSiblings: async (
      turnId: string,
      options?: { signal?: AbortSignal },
    ): Promise<string[]> => {
      const data = await fetchAPI<TurnDto[]>(`/api/turns/${turnId}/siblings`, {
        signal: options?.signal,
      });
      return (data ?? []).map((t) => t.id);
    },

    getContinuation: async (
      threadId: string,
      fromTurnId: string,
      options?: { signal?: AbortSignal },
    ): Promise<Turn[]> => {
      type PaginatedTurnsDto = {
        turns: TurnDto[];
      };
      const data = await fetchAPI<PaginatedTurnsDto>(
        `/api/threads/${threadId}/turns?from_turn_id=${fromTurnId}&limit=100&direction=after`,
        { signal: options?.signal },
      );
      return (data.turns ?? []).map(turnDtoToTurn);
    },

    getBlocks: async (
      turnId: string,
      options?: { signal?: AbortSignal },
    ): Promise<{
      blocks: import("@/features/threads/types").TurnBlock[];
      error?: string;
      status: string;
    }> => {
      // NOTE: Uses camelCase because fetchAPI auto-converts snake_case from backend
      type GetTurnBlocksResponseDto = {
        turnId: string;
        status: string;
        error?: string | null;
        blocks: TurnBlockDto[];
      };
      const data = await fetchAPI<GetTurnBlocksResponseDto>(
        `/api/turns/${turnId}/blocks`,
        {
          signal: options?.signal,
        },
      );
      return {
        blocks: (data.blocks ?? []).map((b) => ({
          id: b.id,
          turnId: b.turnId,
          blockType:
            b.blockType as import("@/features/threads/types").BlockType,
          sequence: b.sequence,
          textContent: b.textContent ?? undefined,
          content: b.content ?? undefined,
          createdAt: new Date(b.createdAt),
        })),
        error: data.error ?? undefined,
        status: data.status,
      };
    },

    interrupt: async (
      turnId: string,
      options?: { signal?: AbortSignal },
    ): Promise<void> => {
      await fetchAPI<void>(`/api/turns/${turnId}/interrupt`, {
        method: "POST",
        signal: options?.signal,
      });
    },

    /**
     * Submit an interjection while an assistant turn is streaming.
     *
     * Returns one of two modes:
     * - "queued": Interjection is buffered for injection at safe boundary
     * - "created": Turn was not streaming; new user + assistant turns created immediately
     */
    submitInterjection: async (
      assistantTurnId: string,
      content: string,
      mode: "append" | "replace",
      options?: { signal?: AbortSignal },
    ): Promise<{
      mode: "queued" | "created";
      assistantTurnId: string;
      content?: string;
      length?: number;
      // Only present when mode === 'created'
      userTurn?: Turn;
      assistantTurn?: Turn;
      streamUrl?: string;
    }> => {
      // NOTE: Response uses camelCase because fetchAPI auto-converts snake_case from backend
      const response = await fetchAPI<{
        mode: "queued" | "created";
        assistantTurnId: string;
        content?: string;
        length?: number;
        userTurn?: TurnDto;
        assistantTurn?: TurnDto;
        streamUrl?: string;
      }>(`/api/turns/${assistantTurnId}/interjection`, {
        method: "POST",
        body: JSON.stringify({ mode, content }),
        signal: options?.signal,
      });

      return {
        mode: response.mode,
        assistantTurnId: response.assistantTurnId,
        content: response.content,
        length: response.length,
        userTurn: response.userTurn
          ? turnDtoToTurn(response.userTurn)
          : undefined,
        assistantTurn: response.assistantTurn
          ? turnDtoToTurn(response.assistantTurn)
          : undefined,
        streamUrl: response.streamUrl,
      };
    },

    /**
     * Clear a queued interjection for an assistant turn.
     * No-op if no interjection is queued or turn is not streaming.
     */
    clearInterjection: async (
      assistantTurnId: string,
      options?: { signal?: AbortSignal },
    ): Promise<void> => {
      await fetchAPI<void>(`/api/turns/${assistantTurnId}/interjection`, {
        method: "DELETE",
        signal: options?.signal,
      });
    },

    /**
     * Get current interjection state for an assistant turn.
     * Used on SSE reconnect to fetch live state instead of stale buffered events.
     */
    getInterjection: async (
      assistantTurnId: string,
      options?: { signal?: AbortSignal },
    ): Promise<{ content: string | null; isStreaming: boolean }> => {
      return fetchAPI<{ content: string | null; isStreaming: boolean }>(
        `/api/turns/${assistantTurnId}/interjection`,
        { signal: options?.signal },
      );
    },
  },

  documents: {
    getTree: async (
      projectId: string,
      options?: { signal?: AbortSignal },
    ): Promise<DocumentTree> => {
      const data = await fetchAPI<DocumentTreeDto>(
        `/api/projects/${projectId}/tree`,
        {
          signal: options?.signal,
        },
      );
      return fromDocumentTreeDto(data);
    },
    get: async (
      id: string,
      options?: { signal?: AbortSignal },
    ): Promise<Document> => {
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        signal: options?.signal,
      });
      return fromDocumentDto(data);
    },
    /**
     * Lightweight AI status check for polling (~100 bytes vs ~50KB full document).
     * Used by useDocumentPolling to efficiently detect AI version changes.
     */
    getAIStatus: async (
      id: string,
      options?: { signal?: AbortSignal },
    ): Promise<AIStatusResponse> => {
      return fetchAPI<AIStatusResponse>(`/api/documents/${id}/ai-status`, {
        signal: options?.signal,
      });
    },
    create: async (
      projectId: string,
      folderId: string | null,
      name: string,
      extension = ".md",
      options?: { signal?: AbortSignal; folderPath?: string },
    ): Promise<Document> => {
      const body: Record<string, unknown> = {
        project_id: projectId,
        name,
        extension,
      };
      // folder_path takes precedence — backend auto-creates missing folders via ResolveFolderPath
      if (options?.folderPath !== undefined) {
        body.folder_path = options.folderPath;
      } else {
        body.folder_id = folderId;
      }
      const data = await fetchAPI<DocumentDto>("/api/documents", {
        method: "POST",
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      return fromDocumentDto(data);
    },
    /**
     * Update document with optional content and/or aiVersion.
     *
     * Tri-state aiVersion semantics:
     * - undefined: omit field (no change to ai_version)
     * - null: clear ai_version
     * - string (including ""): set ai_version
     *
     * Concurrency: when aiVersion is provided, aiVersionBaseRev is required
     * for compare-and-swap (CAS) to prevent overwriting unseen server updates.
     */
    update: async (
      id: string,
      updates: {
        content?: string;
        aiVersion?: string | null;
        aiVersionBaseRev?: number;
      },
      options?: { signal?: AbortSignal },
    ): Promise<Document> => {
      const body: Record<string, unknown> = {};
      if (updates.content !== undefined) body.content = updates.content;
      if (updates.aiVersion !== undefined) {
        // Enforce CAS requirement: backend returns 400 if ai_version_base_rev is missing
        if (updates.aiVersionBaseRev === undefined) {
          throw new Error(
            "aiVersionBaseRev is required when aiVersion is provided",
          );
        }
        body.ai_version = updates.aiVersion;
        body.ai_version_base_rev = updates.aiVersionBaseRev;
      }

      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      return fromDocumentDto(data);
    },
    rename: async (
      id: string,
      projectId: string,
      name: string,
      options?: { signal?: AbortSignal },
    ): Promise<Document> => {
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ project_id: projectId, name }),
        signal: options?.signal,
      });
      return fromDocumentDto(data);
    },
    delete: (id: string, options?: { signal?: AbortSignal }) =>
      fetchAPI<void>(`/api/documents/${id}`, {
        method: "DELETE",
        signal: options?.signal,
      }),
    /**
     * Move a document to a new folder.
     * @param folderId - Target folder ID, or null to move to root
     */
    move: async (
      id: string,
      projectId: string,
      folderId: string | null,
      options?: { signal?: AbortSignal },
    ): Promise<Document> => {
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ project_id: projectId, folder_id: folderId }),
        signal: options?.signal,
      });
      return fromDocumentDto(data);
    },
    /**
     * Import documents from files (zip, markdown, text, or HTML).
     *
     * Uses multipart/form-data for file upload. Note: Do NOT set Content-Type header
     * manually - the browser automatically sets it with the correct boundary when
     * using FormData as the body.
     */
    import: async (
      projectId: string,
      files: File[],
      folderId?: string | null,
      options?: { signal?: AbortSignal; overwrite?: boolean },
    ): Promise<ImportResponse> => {
      const formData = new FormData();
      // Multipart standard: multiple files use the same key name.
      // Backend receives these as an array under "files".
      files.forEach((file) => {
        formData.append("files", file);
      });

      let url = `/api/import?project_id=${encodeURIComponent(projectId)}`;
      if (folderId) {
        url += `&folder_id=${encodeURIComponent(folderId)}`;
      }
      if (options?.overwrite) {
        url += "&overwrite=true";
      }

      // FormData body: browser sets Content-Type to multipart/form-data with boundary
      const data = await fetchAPI<ImportResponse>(url, {
        method: "POST",
        body: formData,
        signal: options?.signal,
      });
      return data;
    },
  },

  folders: {
    create: async (
      projectId: string,
      parentId: string | null,
      name: string,
      options?: { signal?: AbortSignal },
    ): Promise<Folder> => {
      const data = await fetchAPI<FolderDto>("/api/folders", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          folder_id: parentId,
          name,
        }),
        signal: options?.signal,
      });
      return fromFolderDto(data);
    },
    rename: async (
      id: string,
      projectId: string,
      name: string,
      options?: { signal?: AbortSignal },
    ): Promise<Folder> => {
      const data = await fetchAPI<FolderDto>(`/api/folders/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ project_id: projectId, name }),
        signal: options?.signal,
      });
      return fromFolderDto(data);
    },
    /**
     * Move a folder to a new parent folder.
     * @param parentId - Target folder ID, or null to move to root
     */
    move: async (
      id: string,
      projectId: string,
      parentId: string | null,
      options?: { signal?: AbortSignal },
    ): Promise<Folder> => {
      const data = await fetchAPI<FolderDto>(`/api/folders/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ project_id: projectId, folder_id: parentId }),
        signal: options?.signal,
      });
      return fromFolderDto(data);
    },
    delete: (id: string, options?: { signal?: AbortSignal }) =>
      fetchAPI<void>(`/api/folders/${id}`, {
        method: "DELETE",
        signal: options?.signal,
      }),
  },

  skills: {
    list: async (
      projectId: string,
      options?: { signal?: AbortSignal },
    ): Promise<Skill[]> => {
      const data = await fetchAPI<SkillListResponseDto>(
        `/api/projects/${projectId}/skills`,
        {
          signal: options?.signal,
        },
      );
      return data.skills.map(fromSkillDto);
    },
    get: async (
      projectId: string,
      skillId: string,
      options?: { signal?: AbortSignal },
    ): Promise<SkillWithContent> => {
      const data = await fetchAPI<SkillWithContentDto>(
        `/api/projects/${projectId}/skills/${skillId}`,
        {
          signal: options?.signal,
        },
      );
      return fromSkillWithContentDto(data);
    },
    create: async (
      projectId: string,
      skill: CreateSkillRequest,
      options?: { signal?: AbortSignal },
    ): Promise<Skill> => {
      const data = await fetchAPI<SkillDto>(
        `/api/projects/${projectId}/skills`,
        {
          method: "POST",
          body: JSON.stringify({
            name: skill.name,
            description: skill.description,
            content: skill.content,
            disable_model_invocation: skill.disableModelInvocation,
            user_invocable: skill.userInvocable,
          }),
          signal: options?.signal,
        },
      );
      return fromSkillDto(data);
    },
    update: async (
      projectId: string,
      skillId: string,
      updates: UpdateSkillRequest,
      options?: { signal?: AbortSignal },
    ): Promise<Skill> => {
      const body: Record<string, unknown> = {};
      if (updates.name !== undefined) body.name = updates.name;
      if (updates.description !== undefined)
        body.description = updates.description;
      if (updates.content !== undefined) body.content = updates.content;
      if (updates.enabled !== undefined) body.enabled = updates.enabled;
      if (updates.disableModelInvocation !== undefined)
        body.disable_model_invocation = updates.disableModelInvocation;
      if (updates.userInvocable !== undefined)
        body.user_invocable = updates.userInvocable;

      const data = await fetchAPI<SkillDto>(
        `/api/projects/${projectId}/skills/${skillId}`,
        {
          method: "PUT",
          body: JSON.stringify(body),
          signal: options?.signal,
        },
      );
      return fromSkillDto(data);
    },
    delete: (
      projectId: string,
      skillId: string,
      options?: { signal?: AbortSignal },
    ) =>
      fetchAPI<void>(`/api/projects/${projectId}/skills/${skillId}`, {
        method: "DELETE",
        signal: options?.signal,
      }),
  },
};
