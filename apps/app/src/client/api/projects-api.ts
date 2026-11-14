/**
 * projects-api — HTTP client for project, project-thread, works, and context
 * tree/entry endpoints.
 *
 * Thin typed wrappers over the `apps/server` project routes (list/create/delete
 * projects, list threads/works, read context tree, create context entries).
 * Owns the project network surface; no caching or
 * state (that's React Query).
 */

import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type {
  ContextOperationReceipt,
  ContextSourcesResult,
  GetDocumentTrashResponse,
  ListDocumentTrashResponse,
  ProjectChatFeedPage,
  RestoreContextDocumentsRequest,
  RestoreContextDocumentsResponse,
} from "@meridian/contracts/protocol";
import {
  API_ACCOUNT_CONTEXT_SOURCES_PATH,
  API_PROJECTS_PATH,
  apiProjectChatFeedPath,
  apiProjectContextCopyPath,
  apiProjectContextCreateFolderPath,
  apiProjectContextCreatePath,
  apiProjectContextCreateUntitledPath,
  apiProjectContextEntryDeletePath,
  apiProjectContextEntryMovePath,
  apiProjectContextLineagePath,
  apiProjectContextOperationPath,
  apiProjectContextSourcesPath,
  apiProjectDocumentAddressPath,
  apiProjectDocumentReadPath,
  apiProjectPath,
  apiProjectThreadsPath,
  apiProjectWorkingSetPath,
  apiProjectWorksPath,
  type CatalogScope,
  type ContextReadResponse,
  type CopyContextEntriesRequest,
  type CopyContextEntriesResult,
  type CreateContextFolderRequest,
  type CreateContextFolderResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type CreateThreadRequest,
  type CreateThreadResponse,
  type CreateUntitledContextDocumentAnswer,
  type CreateUntitledContextDocumentRequest,
  contextReadResponseSchema,
  type DeleteContextEntryRequest,
  type DeleteContextEntryResult,
  type DocumentAddressRequestOptions,
  type DocumentAddressResult,
  deleteContextEntryResultSchema,
  documentAddressSchema,
  type LineageInfo,
  type ListProjectsResponse,
  type ListProjectThreadsResponse,
  type ListWorksResponse,
  type MoveContextEntryRequest,
  type MoveContextEntryResult,
  type ProjectContextIdentityLookupResult,
  type ProjectContextRequestOptions,
  type ProjectContextTreeScheme,
  type ProjectWorkingSet,
  type ThreadListItem,
  type UpdateProjectRequest,
  type Work,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import { threadSchema } from "@meridian/contracts/threads";
import type { CreateWorkRequest, UpdateWorkRequest } from "@meridian/contracts/works";
import { workSchema, worksSnapshotSchema } from "@meridian/contracts/works";

import { deleteRequest, getJson, patchJson, postJson, putJson } from "./http-client";

type RequestInitOptions = {
  origin?: string;
  headers?: HeadersInit;
  keepalive?: boolean;
  signal?: AbortSignal;
};

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
  return postJson<Work>(urlFor(apiProjectWorksPath(projectId), init), data, {
    headers: init?.headers,
    schema: workSchema,
    signal: init?.signal,
  });
}

export function updateWork(
  workId: string,
  data: UpdateWorkRequest,
  init?: RequestInitOptions,
): Promise<Work> {
  return patchJson<Work>(urlFor(`/api/works/${workId}`, init), data, {
    headers: init?.headers,
    schema: workSchema,
    signal: init?.signal,
  });
}

export function archiveWork(workId: string, init?: RequestInitOptions): Promise<Work> {
  return postJson<Work>(
    urlFor(`/api/works/${workId}/archive`, init),
    {},
    { headers: init?.headers, schema: workSchema, signal: init?.signal },
  );
}

export function unarchiveWork(workId: string, init?: RequestInitOptions): Promise<Work> {
  return postJson<Work>(
    urlFor(`/api/works/${workId}/unarchive`, init),
    {},
    { headers: init?.headers, schema: workSchema, signal: init?.signal },
  );
}

export function deleteWork(workId: string, init?: RequestInitOptions): Promise<void> {
  return deleteRequest(urlFor(`/api/works/${workId}`, init), { signal: init?.signal });
}

export function restoreWork(workId: string, init?: RequestInitOptions): Promise<Work> {
  return postJson<Work>(
    urlFor(`/api/works/${workId}/restore`, init),
    {},
    { headers: init?.headers, schema: workSchema, signal: init?.signal },
  );
}

/** Reading an owned project also completes idempotent default-package seeding. */
export async function getProject(projectId: string, init?: RequestInitOptions): Promise<Project> {
  return getJson(urlFor(apiProjectPath(projectId), init), { headers: init?.headers });
}

export async function getProjectDocumentAddress(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  path: string,
  opts?: DocumentAddressRequestOptions,
  init?: RequestInitOptions,
): Promise<DocumentAddressResult> {
  return getJson(urlFor(apiProjectDocumentAddressPath(projectId, scheme, path, opts), init), {
    headers: init?.headers,
    schema: documentAddressSchema,
  });
}

export async function getProjectWorkingSet(
  projectId: string,
  init?: RequestInitOptions,
): Promise<ProjectWorkingSet | null> {
  return getJson<ProjectWorkingSet | null>(urlFor(apiProjectWorkingSetPath(projectId), init), {
    headers: init?.headers,
  });
}

export async function updateProjectWorkingSet(
  projectId: string,
  snapshot: { recentRoutes: WorkingSetRoute[] },
  init?: RequestInitOptions,
): Promise<{ revision: number }> {
  return putJson<{ revision: number }>(
    urlFor(apiProjectWorkingSetPath(projectId), init),
    snapshot,
    {
      headers: init?.headers,
      keepalive: init?.keepalive,
    },
  );
}

export async function getProjectContextSources(
  projectId: string,
  signal?: AbortSignal,
): Promise<ContextSourcesResult> {
  return getJson(apiProjectContextSourcesPath(projectId), { signal });
}

/**
 * What a chat's uploads query says that its tree list does not (the server's `ChatUploadsResult`):
 * when each file was attached and whether a sent message has used it.
 */
export type ChatUploadFacts = {
  uploads: readonly { documentId: string; attachedAt: string; used: boolean }[];
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

export async function getProjectContextAvailability(
  projectId: string,
  documentIds: readonly string[],
  signal?: AbortSignal,
  folderIds?: readonly string[],
): Promise<ProjectContextIdentityLookupResult> {
  return postJson<ProjectContextIdentityLookupResult>(
    `/api/projects/${encodeURIComponent(projectId)}/context/availability`,
    { projectId, documentIds, ...(folderIds ? { folderIds } : {}) },
    { signal },
  );
}

export async function createProject(
  data: CreateProjectRequest,
  init?: RequestInitOptions,
): Promise<CreateProjectResponse> {
  return postJson<CreateProjectResponse>(urlFor(API_PROJECTS_PATH, init), data, {
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

function acceptsContextConflict(status: number, payload: unknown): boolean {
  return (
    status === 409 &&
    payload !== null &&
    typeof payload === "object" &&
    "status" in payload &&
    payload.status === "conflict"
  );
}

export async function createUntitledContextDocument(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  body: CreateUntitledContextDocumentRequest,
  opts?: ProjectContextRequestOptions,
  init?: RequestInitOptions,
): Promise<CreateUntitledContextDocumentAnswer> {
  const response = await postJson<CreateUntitledContextDocumentAnswer>(
    urlFor(apiProjectContextCreateUntitledPath(projectId, scheme, opts), init),
    body,
    {
      acceptErrorResponse: acceptsContextConflict,
      headers: init?.headers,
      signal: init?.signal,
    },
  );
  if (response.status === "conflict") return response;
  if (response.status === "joined")
    return {
      ...response,
      address: {
        ...response.address,
        path: response.address.path.startsWith("/")
          ? response.address.path
          : `/${response.address.path}`,
      },
    };
  return {
    ...response,
    path: response.path.startsWith("/") ? response.path : `/${response.path}`,
  };
}
export async function createContextFolder(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  body: CreateContextFolderRequest,
  opts?: ProjectContextRequestOptions,
  init?: RequestInitOptions,
): Promise<CreateContextFolderResponse> {
  return postJson(urlFor(apiProjectContextCreateFolderPath(projectId, scheme, opts), init), body, {
    acceptErrorResponse: acceptsContextConflict,
    headers: init?.headers,
    signal: init?.signal,
  });
}

/**
 * Move or rename one entry (file or folder) by its id. The server finds the row, so the request
 * carries no path or owner, and sends only what the writer chose (`MoveContextEntryRequest`).
 */
export async function moveContextEntry(
  projectId: string,
  entryId: string,
  body: MoveContextEntryRequest,
  init?: RequestInitOptions,
): Promise<MoveContextEntryResult> {
  return postJson(urlFor(apiProjectContextEntryMovePath(projectId, entryId), init), body, {
    headers: init?.headers,
    signal: init?.signal,
  });
}

/**
 * One Copy: every selected root into one destination, atomically. The answer is the receipt's
 * result; a refusal is a typed 4xx and a source that has not caught up is a retryable 502 whose
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

export async function getContextOperationReceipt(
  projectId: string,
  operationId: string,
  init?: RequestInitOptions,
): Promise<ContextOperationReceipt | null> {
  const result = await getJson<{ receipt: ContextOperationReceipt | null }>(
    urlFor(apiProjectContextOperationPath(projectId, operationId), init),
    { headers: init?.headers, signal: init?.signal },
  );
  return result.receipt;
}

export function restoreContextDocuments(
  projectId: string,
  body: RestoreContextDocumentsRequest,
  init?: RequestInitOptions,
): Promise<RestoreContextDocumentsResponse> {
  return postJson(
    urlFor(`/api/projects/${encodeURIComponent(projectId)}/context/restore`, init),
    body,
    { headers: init?.headers, signal: init?.signal },
  );
}

export function getDocumentTrash(
  projectId: string,
  init?: RequestInitOptions,
): Promise<ListDocumentTrashResponse> {
  return getJson(urlFor(`/api/projects/${encodeURIComponent(projectId)}/context/trash`, init), {
    headers: init?.headers,
    signal: init?.signal,
  });
}

export function getTrashedDocument(
  projectId: string,
  documentId: string,
  init?: RequestInitOptions,
): Promise<GetDocumentTrashResponse> {
  return getJson(
    urlFor(
      `/api/projects/${encodeURIComponent(projectId)}/context/trash/${encodeURIComponent(documentId)}`,
      init,
    ),
    { headers: init?.headers, signal: init?.signal },
  );
}

export async function deleteContextEntry(
  projectId: string,
  entryId: string,
  body: DeleteContextEntryRequest,
  init?: RequestInitOptions,
): Promise<DeleteContextEntryResult> {
  return postJson<DeleteContextEntryResult>(
    urlFor(apiProjectContextEntryDeletePath(projectId, entryId), init),
    body,
    {
      headers: init?.headers,
      schema: deleteContextEntryResultSchema,
      signal: init?.signal,
    },
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
