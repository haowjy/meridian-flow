/**
 * projects-api — HTTP client for project, project-thread, works, and context
 * tree/entry endpoints.
 *
 * Thin typed wrappers over the `apps/server` project routes (list/create/delete
 * projects, list threads/works, read context tree, create context entries).
 * Owns the project network surface; no caching or
 * state (that's React Query).
 */

import type { Project } from "@meridian/contracts/projects";
import type { HomeProjectResponse } from "@meridian/contracts/protocol";
import {
  API_PROJECTS_PATH,
  apiProjectContextCreatePath,
  apiProjectContextCreateUntitledPath,
  apiProjectContextDeletePath,
  apiProjectContextMovePath,
  apiProjectContextReadPath,
  apiProjectContextRenamePath,
  apiProjectContextTreePath,
  apiProjectPath,
  apiProjectsHomePath,
  apiProjectThreadsPath,
  apiProjectWorkingSetPath,
  apiProjectWorksPath,
  apiProjectWorkWriteModePath,
  type ContextReadResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type CreateThreadRequest,
  type CreateThreadResponse,
  type CreateUntitledContextDocumentRequest,
  type CreateUntitledContextDocumentResponse,
  type CreateUntitledContextDocumentResult,
  type ListProjectsResponse,
  type ListProjectThreadsResponse,
  type ListWorksResponse,
  type MoveContextEntryRequest,
  type MoveContextEntryResult,
  type ProjectContextRequestOptions,
  type ProjectContextTreeResponse,
  type ProjectContextTreeScheme,
  type ProjectWorkingSet,
  type RenameContextEntryRequest,
  type RenameContextEntryResult,
  type ThreadListItem,
  type UpdateWorkWriteModeRequest,
  type UpdateWorkWriteModeResponse,
  type Work,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";

import { deleteRequest, getJson, patchJson, postJson, putJson } from "./http-client";

type RequestInitOptions = {
  origin?: string;
  headers?: HeadersInit;
  keepalive?: boolean;
};

function urlFor(path: string, init?: RequestInitOptions): string {
  return init?.origin ? new URL(path, init.origin).toString() : path;
}

export async function getHomeProject(init?: RequestInitOptions): Promise<HomeProjectResponse> {
  return getJson<HomeProjectResponse>(urlFor(apiProjectsHomePath(), init), {
    headers: init?.headers,
  });
}

export async function listProjects(init?: RequestInitOptions): Promise<Project[]> {
  const response = await getJson<ListProjectsResponse>(urlFor(API_PROJECTS_PATH, init), {
    headers: init?.headers,
  });
  return response.projects;
}

export async function listProjectThreads(
  projectId: string,
  init?: RequestInitOptions,
): Promise<ThreadListItem[]> {
  const response = await getJson<ListProjectThreadsResponse>(
    urlFor(apiProjectThreadsPath(projectId), init),
    { headers: init?.headers },
  );
  return response.threads;
}

export async function listProjectWorks(
  projectId: string,
  init?: RequestInitOptions,
): Promise<ListWorksResponse> {
  return getJson<ListWorksResponse>(urlFor(apiProjectWorksPath(projectId), init), {
    headers: init?.headers,
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
  snapshot: { recentRoutes: WorkingSetRoute[]; lastThreadId: string | null },
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

export async function updateWorkWriteMode(
  projectId: string,
  workId: string,
  input: Work["aiWriteMode"] | UpdateWorkWriteModeRequest,
  init?: RequestInitOptions,
): Promise<UpdateWorkWriteModeResponse> {
  const body = typeof input === "string" ? { aiWriteMode: input } : input;
  return patchJson<UpdateWorkWriteModeResponse>(
    urlFor(apiProjectWorkWriteModePath(projectId, workId), init),
    body,
    { headers: init?.headers },
  );
}

export async function getProjectContextTree(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  opts?: ProjectContextRequestOptions,
  init?: RequestInitOptions,
): Promise<ProjectContextTreeResponse> {
  return getJson<ProjectContextTreeResponse>(
    urlFor(apiProjectContextTreePath(projectId, scheme, opts), init),
    {
      headers: init?.headers,
    },
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
    headers: init?.headers,
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  return deleteRequest(apiProjectPath(projectId));
}

export async function createContextEntry(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  body: { type: "file" | "folder"; path: string; content?: string },
  opts?: ProjectContextRequestOptions,
  init?: RequestInitOptions,
): Promise<{ status: "created"; documentId?: string } | { status: "conflict"; uri: string }> {
  return postJson(urlFor(apiProjectContextCreatePath(projectId, scheme, opts), init), body, {
    headers: init?.headers,
    acceptStatuses: [409],
  });
}

export async function createUntitledContextDocument(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  body: CreateUntitledContextDocumentRequest,
  opts?: ProjectContextRequestOptions,
): Promise<CreateUntitledContextDocumentResult> {
  const response = await postJson<CreateUntitledContextDocumentResponse | { error: true }>(
    apiProjectContextCreateUntitledPath(projectId, scheme, opts),
    body,
    { acceptStatuses: [409] },
  );
  if ("error" in response) return { status: "conflict" };
  return {
    ...response,
    path: response.path.startsWith("/") ? response.path : `/${response.path}`,
  };
}
export async function renameContextEntry(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  body: RenameContextEntryRequest,
  opts?: ProjectContextRequestOptions,
  init?: RequestInitOptions,
): Promise<RenameContextEntryResult> {
  const response = await postJson<{ status?: number; statusCode?: number } | { status: "renamed" }>(
    urlFor(apiProjectContextRenamePath(projectId, scheme, opts), init),
    body,
    { headers: init?.headers, acceptStatuses: [409] },
  );
  return {
    status:
      response.status === 409 || ("statusCode" in response && response.statusCode === 409)
        ? "conflict"
        : "renamed",
  };
}

/**
 * Move (and optionally rename) a context entry across folders or schemes.
 * Paths in the request/response are scheme-relative WITHOUT a leading slash
 * (the tree DTO uses leading slashes — callers translate at this seam).
 */
export async function moveContextEntry(
  projectId: string,
  sourceScheme: ProjectContextTreeScheme,
  body: MoveContextEntryRequest,
): Promise<MoveContextEntryResult> {
  return postJson(apiProjectContextMovePath(projectId, sourceScheme), body, {
    acceptStatuses: [409],
  });
}

export async function deleteContextEntry(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  body: { path: string },
  opts?: ProjectContextRequestOptions,
  init?: RequestInitOptions,
): Promise<void> {
  await postJson(urlFor(apiProjectContextDeletePath(projectId, scheme, opts), init), body, {
    headers: init?.headers,
  });
}

export async function getProjectContextRead(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  path: string,
  opts?: ProjectContextRequestOptions,
  init?: RequestInitOptions,
): Promise<ContextReadResponse> {
  return getJson<ContextReadResponse>(
    urlFor(apiProjectContextReadPath(projectId, scheme, path, opts), init),
    { headers: init?.headers },
  );
}
