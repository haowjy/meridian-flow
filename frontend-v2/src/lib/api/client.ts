import type { BackendTurn } from "@/features/threads/transport-types"

import { fetchAPI } from "./fetch-api"
import type {
  DocumentDto,
  DocumentTreeDto,
  FolderDto,
  PaginatedTurnsDto,
  ProjectDto,
  SendTurnResponse,
  ThreadDto,
  TurnDto,
} from "./types"
import {
  fromDocumentDto,
  fromDocumentTreeDto,
  fromProjectDto,
  fromThreadDto,
} from "./types"

type ListOptions = { signal?: AbortSignal }

export const api = {
  projects: {
    list: async (options?: ListOptions) => {
      const data = await fetchAPI<ProjectDto[]>("/api/projects", {
        signal: options?.signal,
      })
      return data.map(fromProjectDto)
    },
    get: async (id: string, options?: ListOptions) => {
      const data = await fetchAPI<ProjectDto>(`/api/projects/${id}`, {
        signal: options?.signal,
      })
      return fromProjectDto(data)
    },
  },

  documents: {
    getTree: async (projectId: string, options?: ListOptions) => {
      const data = await fetchAPI<DocumentTreeDto>(
        `/api/projects/${projectId}/tree`,
        { signal: options?.signal },
      )
      return fromDocumentTreeDto(data)
    },
    get: async (id: string, options?: ListOptions) => {
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        signal: options?.signal,
      })
      return fromDocumentDto(data)
    },
    create: async (
      projectId: string,
      folderId: string | null,
      name: string,
      extension = ".md",
      options?: ListOptions & { folderPath?: string },
    ) => {
      const body: Record<string, unknown> = {
        project_id: projectId,
        name,
        extension,
      }
      if (options?.folderPath !== undefined) {
        body.folder_path = options.folderPath
      } else {
        body.folder_id = folderId
      }
      const data = await fetchAPI<DocumentDto>("/api/documents", {
        method: "POST",
        body: JSON.stringify(body),
        signal: options?.signal,
      })
      return fromDocumentDto(data)
    },
    update: async (
      id: string,
      updates: { content?: string },
      options?: ListOptions,
    ) => {
      const body: Record<string, unknown> = {}
      if (updates.content !== undefined) body.content = updates.content
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        signal: options?.signal,
      })
      return fromDocumentDto(data)
    },
    delete: (id: string, options?: ListOptions) =>
      fetchAPI<void>(`/api/documents/${id}`, {
        method: "DELETE",
        signal: options?.signal,
      }),
    move: async (
      id: string,
      projectId: string,
      folderId: string | null,
      options?: ListOptions,
    ) => {
      const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ project_id: projectId, folder_id: folderId }),
        signal: options?.signal,
      })
      return fromDocumentDto(data)
    },
  },

  folders: {
    create: async (
      projectId: string,
      parentId: string | null,
      name: string,
      options?: ListOptions,
    ) => {
      const data = await fetchAPI<FolderDto>("/api/folders", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          folder_id: parentId,
          name,
        }),
        signal: options?.signal,
      })
      return data
    },
    rename: async (
      id: string,
      projectId: string,
      name: string,
      options?: ListOptions,
    ) => {
      return fetchAPI<FolderDto>(`/api/folders/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ project_id: projectId, name }),
        signal: options?.signal,
      })
    },
    move: async (
      id: string,
      projectId: string,
      parentId: string | null,
      options?: ListOptions,
    ) => {
      return fetchAPI<FolderDto>(`/api/folders/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          project_id: projectId,
          folder_id: parentId,
        }),
        signal: options?.signal,
      })
    },
    delete: (id: string, options?: ListOptions) =>
      fetchAPI<void>(`/api/folders/${id}`, {
        method: "DELETE",
        signal: options?.signal,
      }),
  },

  threads: {
    list: async (projectId: string, options?: ListOptions) => {
      const data = await fetchAPI<ThreadDto[]>(
        `/api/threads?project_id=${encodeURIComponent(projectId)}`,
        { signal: options?.signal },
      )
      return data.map(fromThreadDto)
    },
    get: async (id: string, options?: ListOptions) => {
      const data = await fetchAPI<ThreadDto>(`/api/threads/${id}`, {
        signal: options?.signal,
      })
      return fromThreadDto(data)
    },
    create: async (
      projectId: string,
      title: string,
      options?: ListOptions,
    ) => {
      const data = await fetchAPI<ThreadDto>("/api/threads", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, title }),
        signal: options?.signal,
      })
      return fromThreadDto(data)
    },
  },

  turns: {
    paginate: async (
      threadId: string,
      options?: {
        fromTurnId?: string
        direction?: "before" | "after" | "both" | ""
        limit?: number
        updateLastViewed?: boolean
        signal?: AbortSignal
      },
    ) => {
      const params = new URLSearchParams()
      if (options?.fromTurnId) params.set("from_turn_id", options.fromTurnId)
      if (options?.limit && options.limit > 0) {
        params.set("limit", String(options.limit))
      }
      if (options?.direction) params.set("direction", options.direction)
      if (options?.updateLastViewed) {
        params.set("update_last_viewed", String(options.updateLastViewed))
      }

      const query = params.toString()
      const endpoint = `/api/threads/${threadId}/turns${query ? `?${query}` : ""}`
      const data = await fetchAPI<PaginatedTurnsDto>(endpoint, {
        signal: options?.signal,
      })

      return {
        turns: (data.turns ?? []) as BackendTurn[],
        hasMoreBefore: !!data.hasMoreBefore,
        hasMoreAfter: !!data.hasMoreAfter,
      }
    },

    send: async (
      message: string,
      options: {
        threadId?: string
        projectId?: string
        prevTurnId?: string | null
        signal?: AbortSignal
      },
    ) => {
      const response = await fetchAPI<SendTurnResponse>("/api/turns", {
        method: "POST",
        body: JSON.stringify({
          thread_id: options.threadId ?? null,
          project_id: options.projectId ?? null,
          role: "user",
          turn_blocks: [
            {
              block_type: "text",
              text_content: message,
              content: null,
            },
          ],
          prev_turn_id: options.prevTurnId ?? null,
        }),
        signal: options?.signal,
      })

      return {
        thread: response.thread ? fromThreadDto(response.thread) : undefined,
        userTurn: response.userTurn as BackendTurn,
        assistantTurn: response.assistantTurn as BackendTurn,
        streamUrl: response.streamUrl,
      }
    },
  },
}

export type { TurnDto }
