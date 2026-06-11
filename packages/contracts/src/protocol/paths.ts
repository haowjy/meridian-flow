import type { ProjectContextTreeScheme } from "./http-types.js";

export const API_PROJECTS_PATH = "/api/projects";
export const API_THREADS_PATH = "/api/threads";
export const API_THREADS_WS_PATH = "/api/threads/ws";
export { YJS_WS_PATH_PREFIX, yjsWsPath } from "./yjs-ws.js";

export function apiProjectPath(projectId: string): string {
  return `${API_PROJECTS_PATH}/${projectId}`;
}

export function apiProjectThreadsPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/threads`;
}

export function apiProjectWorksPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/works`;
}

export function apiProjectPreferencesPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/preferences`;
}

export function apiProjectContextTreePath(
  projectId: string,
  scheme: ProjectContextTreeScheme,
): string {
  return `${apiProjectPath(projectId)}/context/${scheme}/tree`;
}

export function apiThreadPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}`;
}

export function apiThreadMessagePath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/messages`;
}

export function apiThreadCancelPath(threadId: string, turnId: string): string {
  return `${API_THREADS_PATH}/${threadId}/turns/${turnId}/cancel`;
}

export function apiThreadSnapshotPath(
  threadId: string,
  opts?: { after?: string; epoch?: string },
): string {
  const search = new URLSearchParams();
  if (opts?.after) search.set("after", opts.after);
  if (opts?.epoch) search.set("epoch", opts.epoch);
  const query = search.toString();
  return `${API_THREADS_PATH}/${threadId}/snapshot${query ? `?${query}` : ""}`;
}

export function apiThreadsWsPath(): string {
  return API_THREADS_WS_PATH;
}
