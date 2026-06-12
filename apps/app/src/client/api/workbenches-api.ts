// @ts-nocheck
/**
 * workbenches-api — HTTP client for workbench, workbench-thread, works, preferences,
 * and context tree/entry endpoints.
 *
 * Thin typed wrappers over the `apps/server` workbench routes (list/create/delete
 * workbenches, list threads/works, read/update preferences, read context tree,
 * create context entries). Owns the workbench network surface; no caching or
 * state (that's React Query).
 */

import type {
  UpdateWorkbenchPreferencesRequest,
  WorkbenchPreferences,
  WorkbenchPreferencesResponse,
} from "@meridian/contracts/preferences";
import {
  API_WORKBENCHES_PATH,
  apiWorkbenchContextCreatePath,
  apiWorkbenchContextReadPath,
  apiWorkbenchContextTreePath,
  apiWorkbenchPath,
  apiWorkbenchPreferencesPath,
  apiWorkbenchThreadsPath,
  apiWorkbenchWorksPath,
  type ContextReadResponse,
  type CreateThreadRequest,
  type CreateThreadResponse,
  type CreateWorkbenchRequest,
  type CreateWorkbenchResponse,
  type ListWorkbenchesResponse,
  type ListWorkbenchThreadsResponse,
  type ListWorksResponse,
  type ThreadListItem,
  type Work,
  type WorkbenchContextTreeResponse,
  type WorkbenchContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { Workbench } from "@meridian/contracts/workbenches";

import { deleteRequest, getJson, postJson, putJson } from "./http-client";

type RequestInitOptions = {
  origin?: string;
  headers?: HeadersInit;
};

function urlFor(path: string, init?: RequestInitOptions): string {
  return init?.origin ? new URL(path, init.origin).toString() : path;
}

export async function listWorkbenches(init?: RequestInitOptions): Promise<Workbench[]> {
  const response = await getJson<ListWorkbenchesResponse>(urlFor(API_WORKBENCHES_PATH, init), {
    headers: init?.headers,
  });
  return response.workbenches;
}

export async function listWorkbenchThreads(
  workbenchId: string,
  init?: RequestInitOptions,
): Promise<ThreadListItem[]> {
  const response = await getJson<ListWorkbenchThreadsResponse>(
    urlFor(apiWorkbenchThreadsPath(workbenchId), init),
    { headers: init?.headers },
  );
  return response.threads;
}

export async function listWorkbenchWorks(
  workbenchId: string,
  init?: RequestInitOptions,
): Promise<Work[]> {
  const response = await getJson<ListWorksResponse>(
    urlFor(apiWorkbenchWorksPath(workbenchId), init),
    {
      headers: init?.headers,
    },
  );
  return response.works;
}

export async function getWorkbenchPreferences(
  workbenchId: string,
  init?: RequestInitOptions,
): Promise<WorkbenchPreferences> {
  const response = await getJson<WorkbenchPreferencesResponse>(
    urlFor(apiWorkbenchPreferencesPath(workbenchId), init),
    { headers: init?.headers },
  );
  return response.preferences;
}

export async function updateWorkbenchPreferences(
  workbenchId: string,
  data: UpdateWorkbenchPreferencesRequest,
  init?: RequestInitOptions,
): Promise<WorkbenchPreferences> {
  const response = await putJson<WorkbenchPreferencesResponse>(
    urlFor(apiWorkbenchPreferencesPath(workbenchId), init),
    data,
    { headers: init?.headers },
  );
  return response.preferences;
}

export async function getWorkbenchContextTree(
  workbenchId: string,
  scheme: WorkbenchContextTreeScheme,
  init?: RequestInitOptions,
): Promise<WorkbenchContextTreeResponse> {
  return getJson<WorkbenchContextTreeResponse>(
    urlFor(apiWorkbenchContextTreePath(workbenchId, scheme), init),
    {
      headers: init?.headers,
    },
  );
}

export async function createWorkbench(
  data: CreateWorkbenchRequest,
  init?: RequestInitOptions,
): Promise<CreateWorkbenchResponse> {
  return postJson<CreateWorkbenchResponse>(urlFor(API_WORKBENCHES_PATH, init), data, {
    headers: init?.headers,
  });
}

export async function createWorkbenchThread(
  workbenchId: string,
  data: Omit<CreateThreadRequest, "workbenchId">,
  init?: RequestInitOptions,
): Promise<CreateThreadResponse> {
  return postJson<CreateThreadResponse>(urlFor(apiWorkbenchThreadsPath(workbenchId), init), data, {
    headers: init?.headers,
  });
}

export async function deleteWorkbench(workbenchId: string): Promise<void> {
  return deleteRequest(apiWorkbenchPath(workbenchId));
}

export async function createContextEntry(
  workbenchId: string,
  scheme: WorkbenchContextTreeScheme,
  body: { type: "file" | "folder"; path: string; content?: string },
  init?: RequestInitOptions,
): Promise<void> {
  await postJson(urlFor(apiWorkbenchContextCreatePath(workbenchId, scheme), init), body, {
    headers: init?.headers,
  });
}
export async function getWorkbenchContextRead(
  workbenchId: string,
  scheme: WorkbenchContextTreeScheme,
  path: string,
  init?: RequestInitOptions,
): Promise<ContextReadResponse> {
  return getJson<ContextReadResponse>(
    urlFor(apiWorkbenchContextReadPath(workbenchId, scheme, path), init),
    { headers: init?.headers },
  );
}
