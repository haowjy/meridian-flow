/**
 * projects-api — HTTP client for project, project-thread, works, and context
 * tree/entry endpoints.
 *
 * Thin typed wrappers over the `apps/server` project routes (list/create/delete
 * projects, list threads/works, read context tree, create context entries).
 * Owns the project network surface; no caching or
 * state (that's React Query).
 */

import type { CommandBody } from "@meridian/contracts/commands";
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type {
  ContextSourcesResult,
  DocumentTrashEntry,
  ListTrashResponse,
  ProjectChatFeedPage,
} from "@meridian/contracts/protocol";
import {
  API_ACCOUNT_CONTEXT_SOURCES_PATH,
  API_PROJECTS_PATH,
  apiProjectChatFeedPath,
  apiProjectContextCopyPath,
  apiProjectContextLineagePath,
  apiProjectContextSourcesPath,
  apiProjectDocumentReadPath,
  apiProjectPath,
  apiProjectThreadsPath,
  apiProjectWorksPath,
  type ContextReadResponse,
  type CopyContextEntriesRequest,
  type CopyContextEntriesResult,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type CreateThreadRequest,
  type CreateThreadResponse,
  contextReadResponseSchema,
  type LineageInfo,
  type ListProjectsResponse,
  type ListProjectThreadsResponse,
  type ListWorksResponse,
  type ThreadListItem,
  type UpdateProjectRequest,
  type Work,
} from "@meridian/contracts/protocol";
import { threadSchema } from "@meridian/contracts/threads";
import type { CreateWorkRequest, UpdateWorkRequest, WorkAnswer } from "@meridian/contracts/works";
import { workAnswerSchema, workSchema, worksSnapshotSchema } from "@meridian/contracts/works";

import { deleteRequest, getJson, patchJson, postJson } from "./http-client";

type RequestInitOptions = {
  origin?: string;
  headers?: HeadersInit;
  keepalive?: boolean;
  signal?: AbortSignal;
};

/** A command's body carries a fresh id per request, minted here once the caller has decided to send. */
function withCommandId<T extends object>(data: T): CommandBody<T> {
  return { ...data, commandId: crypto.randomUUID() };
}

function urlFor(path: string, init?: RequestInitOptions): string {
  return init?.origin ? new URL(path, init.origin).toString() : path;
}

export function getProjectChatFeed(
  projectId: string,
  cursor?: string | null,
  signal?: AbortSignal,
  favorite = false,
  search: string | null = null,
  workId: string | null = null,
): Promise<ProjectChatFeedPage> {
  return getJson<ProjectChatFeedPage>(
    apiProjectChatFeedPath(projectId, { cursor, favorite, search, workId }),
    { signal },
  );
}

export async function listProjects(init?: RequestInitOptions): Promise<Project[]> {
  const response = await getJson<ListProjectsResponse>(urlFor(API_PROJECTS_PATH, init), {
    headers: init?.headers,
  });
  return response.projects;
}

export function updateProject(
  projectId: string,
  data: UpdateProjectRequest,
  init?: RequestInitOptions,
): Promise<Project> {
  return patchJson<Project>(urlFor(apiProjectPath(projectId), init), data, {
    headers: init?.headers,
  });
}

export async function listProjectThreads(
  projectId: string,
  init?: RequestInitOptions,
): Promise<ThreadListItem[]> {
  const response = await getJson<ListProjectThreadsResponse>(
    urlFor(apiProjectThreadsPath(projectId), init),
    { headers: init?.headers, signal: init?.signal },
  );
  return response.threads;
}

export async function listProjectWorks(
  projectId: string,
  options?: RequestInitOptions,
): Promise<ListWorksResponse> {
  const path = apiProjectWorksPath(projectId);
  return getJson<ListWorksResponse>(urlFor(path, options), {
    headers: options?.headers,
    signal: options?.signal,
    schema: worksSnapshotSchema,
  });
}

export function createProjectWork(
  projectId: string,
  data: CreateWorkRequest,
  init?: RequestInitOptions,
): Promise<Work> {
  return postJson<Work>(urlFor(apiProjectWorksPath(projectId), init), withCommandId(data), {
    headers: init?.headers,
    schema: workSchema,
    signal: init?.signal,
  });
}

export function updateWork(
  workId: string,
  data: UpdateWorkRequest,
  init?: RequestInitOptions,
): Promise<WorkAnswer> {
  return patchJson<WorkAnswer>(urlFor(`/api/works/${workId}`, init), withCommandId(data), {
    headers: init?.headers,
    schema: workAnswerSchema,
    signal: init?.signal,
  });
}

export function archiveWork(workId: string, init?: RequestInitOptions): Promise<Work> {
  return postJson<Work>(urlFor(`/api/works/${workId}/archive`, init), withCommandId({}), {
    headers: init?.headers,
    schema: workSchema,
    signal: init?.signal,
  });
}

export function unarchiveWork(workId: string, init?: RequestInitOptions): Promise<Work> {
  return postJson<Work>(urlFor(`/api/works/${workId}/unarchive`, init), withCommandId({}), {
    headers: init?.headers,
    schema: workSchema,
    signal: init?.signal,
  });
}

export function deleteWork(workId: string, init?: RequestInitOptions): Promise<void> {
  return deleteRequest(urlFor(`/api/works/${workId}`, init), {
    body: withCommandId({}),
    signal: init?.signal,
  });
}

export function restoreWork(workId: string, init?: RequestInitOptions): Promise<Work> {
  return postJson<Work>(urlFor(`/api/works/${workId}/restore`, init), withCommandId({}), {
    headers: init?.headers,
    schema: workSchema,
    signal: init?.signal,
  });
}

/** Reading an owned project also completes idempotent default-package seeding. */
export async function getProject(projectId: string, init?: RequestInitOptions): Promise<Project> {
  return getJson(urlFor(apiProjectPath(projectId), init), { headers: init?.headers });
}

export async function getProjectContextSources(
  projectId: string,
  signal?: AbortSignal,
): Promise<ContextSourcesResult> {
  return getJson(apiProjectContextSourcesPath(projectId), { signal });
}

/**
 * What a chat's uploads query says that its tree list does not (the server's `ChatUploadsResult`):
 * when each file was attached.
 */
export type ChatUploadFacts = {
  uploads: readonly { documentId: string; attachedAt: string }[];
};

export async function getChatUploadFacts(
  projectId: string,
  chatId: string,
  signal?: AbortSignal,
): Promise<ChatUploadFacts> {
  return getJson(
    `${apiProjectPath(projectId)}/context/chat-uploads?chatId=${encodeURIComponent(chatId)}`,
    { signal },
  );
}

export async function getAccountContextSources(
  signal?: AbortSignal,
): Promise<ContextSourcesResult> {
  return getJson(API_ACCOUNT_CONTEXT_SOURCES_PATH, { signal });
}

export async function createProject(
  data: CreateProjectRequest,
  init?: RequestInitOptions,
): Promise<CreateProjectResponse> {
  return postJson<CreateProjectResponse>(urlFor(API_PROJECTS_PATH, init), withCommandId(data), {
    headers: init?.headers,
  });
}

export async function createProjectThread(
  projectId: string,
  data: Omit<CreateThreadRequest, "projectId">,
  init?: RequestInitOptions,
): Promise<CreateThreadResponse> {
  return postJson<CreateThreadResponse>(urlFor(apiProjectThreadsPath(projectId), init), data, {
    schema: threadSchema,
    headers: init?.headers,
    signal: init?.signal,
  });
}

/**
 * One Copy: every selected root into one destination, atomically. The answer is the receipt's
 * result; a refusal is a typed 4xx and a source that has not caught up is a retryable 503 whose
 * details name `source_behind`.
 */
export async function copyContextEntries(
  projectId: string,
  body: CopyContextEntriesRequest,
  init?: RequestInitOptions,
): Promise<CopyContextEntriesResult> {
  return postJson(urlFor(apiProjectContextCopyPath(projectId), init), body, {
    headers: init?.headers,
    signal: init?.signal,
  });
}

export function getTrash(projectId: string, init?: RequestInitOptions): Promise<ListTrashResponse> {
  return getJson(urlFor(`/api/projects/${encodeURIComponent(projectId)}/context/trash`, init), {
    headers: init?.headers,
    signal: init?.signal,
  });
}

export function getTrashedDocument(
  projectId: string,
  documentId: string,
  init?: RequestInitOptions,
): Promise<DocumentTrashEntry> {
  return getJson(
    urlFor(
      `/api/projects/${encodeURIComponent(projectId)}/context/trash/${encodeURIComponent(documentId)}`,
      init,
    ),
    { headers: init?.headers, signal: init?.signal },
  );
}

export async function getProjectDocumentRead(
  projectId: string,
  documentId: string,
  init?: RequestInitOptions,
): Promise<ContextReadResponse> {
  return getJson<ContextReadResponse>(
    urlFor(apiProjectDocumentReadPath(projectId, documentId), init),
    {
      headers: init?.headers,
      schema: contextReadResponseSchema,
    },
  );
}

/** The first chat's handle and title for a lineage, even when that chat is trashed. */
export async function getContextLineage(
  projectId: string,
  rootThreadId: string,
  signal?: AbortSignal,
): Promise<LineageInfo> {
  return getJson<LineageInfo>(apiProjectContextLineagePath(projectId, rootThreadId), { signal });
}
