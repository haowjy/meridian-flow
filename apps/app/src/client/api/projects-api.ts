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
  apiProjectContextReadPath,
  apiProjectContextRenamePath,
  apiProjectContextTreePath,
  apiProjectPath,
  apiProjectsHomePath,
  apiProjectThreadsPath,
  apiProjectWorksPath,
  apiProjectWorkWriteModePath,
  type ContextReadResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type CreateThreadRequest,
  type CreateThreadResponse,
  type ListProjectsResponse,
  type ListProjectThreadsResponse,
  type ListWorksResponse,
  type ProjectContextRequestOptions,
  type ProjectContextTreeResponse,
  type ProjectContextTreeScheme,
  type ThreadListItem,
  type UpdateWorkWriteModeRequest,
  type UpdateWorkWriteModeResponse,
  type Work,
} from "@meridian/contracts/protocol";

import { deleteRequest, getJson, patchJson, postJson } from "./http-client";

type RequestInitOptions = {
  origin?: string;
  headers?: HeadersInit;
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

export type CreateUntitledContextDocumentResponse = {
  status: "created" | "already-exists";
  documentId: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  name: string;
};

export async function createUntitledContextDocument(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  body: { documentId: string; folderPath?: string },
  opts?: ProjectContextRequestOptions,
): Promise<CreateUntitledContextDocumentResponse> {
  return postJson(apiProjectContextCreateUntitledPath(projectId, scheme, opts), body);
}
export async function renameContextEntry(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  body: { path: string; newName: string },
  opts?: ProjectContextRequestOptions,
  init?: RequestInitOptions,
): Promise<{ ok: true }> {
  return postJson(urlFor(apiProjectContextRenamePath(projectId, scheme, opts), init), body, {
    headers: init?.headers,
  });
}

/** Rename variant for UI that needs to recover from a race-lost 409 in place. */
export async function renameContextEntryWithConflict(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  body: { path: string; newName: string },
  opts?: ProjectContextRequestOptions,
): Promise<{ status: "renamed" | "conflict" }> {
  const response = await postJson<{ ok?: true; statusCode?: number }>(
    apiProjectContextRenamePath(projectId, scheme, opts),
    body,
    { acceptStatuses: [409] },
  );
  return { status: response.statusCode === 409 ? "conflict" : "renamed" };
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
