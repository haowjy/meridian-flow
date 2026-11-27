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
import type { UpdateWorkRequest, WorkAnswer } from "@meridian/contracts/works";
import { workAnswerSchema, workSchema, worksSnapshotSchema } from "@meridian/contracts/works";

import { getJson, patchJson, postJson } from "./http-client";

type RequestInitOptions = {
  origin?: string;
  headers?: HeadersInit;
  keepalive?: boolean;
  signal?: AbortSignal;
};

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

export function restoreWork(workId: string, init?: RequestInitOptions): Promise<Work> {
  return postJson<Work>(urlFor(`/api/works/${workId}/restore`, init), withCommandId({}), {
    headers: init?.headers,
    schema: workSchema,
    signal: init?.signal,
  });
}

export async function getProject(projectId: string, init?: RequestInitOptions): Promise<Project> {
  return getJson(urlFor(apiProjectPath(projectId), init), { headers: init?.headers });
}

export async function getProjectContextSources(
  projectId: string,
  signal?: AbortSignal,
): Promise<ContextSourcesResult> {
  return getJson(apiProjectContextSourcesPath(projectId), { signal });
}

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

export async function getContextLineage(
  projectId: string,
  rootThreadId: string,
  signal?: AbortSignal,
): Promise<LineageInfo> {
  return getJson<LineageInfo>(apiProjectContextLineagePath(projectId, rootThreadId), { signal });
}
