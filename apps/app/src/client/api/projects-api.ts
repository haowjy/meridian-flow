/**
 * projects-api — HTTP client for project, project-thread, works, preferences,
 * and context tree/entry endpoints.
 *
 * Thin typed wrappers over the `apps/server` project routes (list/create/delete
 * projects, list threads/works, read/update preferences, read context tree,
 * create context entries). Owns the project network surface; no caching or
 * state (that's React Query).
 */

import type {
  ProjectPreferences,
  ProjectPreferencesResponse,
  UpdateProjectPreferencesRequest,
} from "@meridian/contracts/preferences";
import type { Project } from "@meridian/contracts/projects";
import type { HomeProjectResponse } from "@meridian/contracts/protocol";
import {
  API_PROJECTS_PATH,
  apiProjectContextCreatePath,
  apiProjectContextReadPath,
  apiProjectContextTreePath,
  apiProjectPath,
  apiProjectPreferencesPath,
  apiProjectsHomePath,
  apiProjectThreadsPath,
  apiProjectWorksPath,
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
  type Work,
} from "@meridian/contracts/protocol";

import { deleteRequest, getJson, postJson, putJson } from "./http-client";

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
): Promise<Work[]> {
  const response = await getJson<ListWorksResponse>(urlFor(apiProjectWorksPath(projectId), init), {
    headers: init?.headers,
  });
  return response.works;
}

export async function getProjectPreferences(
  projectId: string,
  init?: RequestInitOptions,
): Promise<ProjectPreferences> {
  const response = await getJson<ProjectPreferencesResponse>(
    urlFor(apiProjectPreferencesPath(projectId), init),
    { headers: init?.headers },
  );
  return response.preferences;
}

export async function updateProjectPreferences(
  projectId: string,
  data: UpdateProjectPreferencesRequest,
  init?: RequestInitOptions,
): Promise<ProjectPreferences> {
  const response = await putJson<ProjectPreferencesResponse>(
    urlFor(apiProjectPreferencesPath(projectId), init),
    data,
    { headers: init?.headers },
  );
  return response.preferences;
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
): Promise<void> {
  await postJson(urlFor(apiProjectContextCreatePath(projectId, scheme, opts), init), body, {
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
