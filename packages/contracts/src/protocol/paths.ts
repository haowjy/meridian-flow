/**
 * Purpose: Provides canonical API path constants and URL builders for Meridian workbench, thread, context, and Yjs endpoints.
 * Why independent: Route paths are a shared client/server protocol primitive and should not be duplicated inside app code.
 */
import type { WorkbenchContextTreeScheme } from "./http-types.js";
export const API_WORKBENCHES_PATH = "/api/workbenches";

export const API_THREADS_PATH = "/api/threads";
export const API_THREADS_WS_PATH = "/api/threads/ws";
export { YJS_WS_PATH_PREFIX, yjsWsPath } from "./yjs-ws.js";

export function apiWorkbenchPath(workbenchId: string): string {
  return `${API_WORKBENCHES_PATH}/${workbenchId}`;
}

export function apiWorkbenchThreadsPath(workbenchId: string): string {
  return `${apiWorkbenchPath(workbenchId)}/threads`;
}

export function apiWorkbenchWorksPath(workbenchId: string): string {
  return `${apiWorkbenchPath(workbenchId)}/works`;
}

/** (user, workbench)-scoped UI preferences — user resolved from auth. */
export function apiWorkbenchPreferencesPath(workbenchId: string): string {
  return `${apiWorkbenchPath(workbenchId)}/preferences`;
}

/** Selectable agent catalog for composer picker and Library. */
export function apiWorkbenchAgentsPath(workbenchId: string): string {
  return `${apiWorkbenchPath(workbenchId)}/agents`;
}

export function apiWorkbenchContextTreePath(
  workbenchId: string,
  scheme: WorkbenchContextTreeScheme,
): string {
  return `${apiWorkbenchPath(workbenchId)}/context/${scheme}/tree`;
}

export function apiWorkbenchContextCreatePath(
  workbenchId: string,
  scheme: WorkbenchContextTreeScheme,
): string {
  return `${apiWorkbenchPath(workbenchId)}/context/${scheme}/create`;
}

export function apiWorkbenchContextReadPath(
  workbenchId: string,
  scheme: WorkbenchContextTreeScheme,
  path: string,
): string {
  return `${apiWorkbenchPath(workbenchId)}/context/${scheme}/read?path=${encodeURIComponent(path)}`;
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

export function apiThreadUploadsPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/uploads`;
}

export function apiThreadRecentDocumentsPath(threadId: string, opts?: { limit?: number }): string {
  const search = new URLSearchParams();
  if (opts?.limit != null) {
    search.set("limit", String(opts.limit));
  }
  const query = search.toString();
  return `${API_THREADS_PATH}/${threadId}/recent-documents${query ? `?${query}` : ""}`;
}

export function apiThreadModelRequestsDebugPath(
  threadId: string,
  opts?: { turnId?: string },
): string {
  const search = new URLSearchParams();
  if (opts?.turnId) {
    search.set("turnId", opts.turnId);
  }
  const query = search.toString();
  return `${API_THREADS_PATH}/${threadId}/debug/model-requests${query ? `?${query}` : ""}`;
}

export function apiThreadTurnContextPreviewDebugPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/debug/turn-context-preview`;
}

export function apiThreadSnapshotPath(
  threadId: string,
  opts?: { after?: string; epoch?: string },
): string {
  const search = new URLSearchParams();
  if (opts?.after) {
    search.set("after", opts.after);
  }
  if (opts?.epoch) {
    search.set("epoch", opts.epoch);
  }
  const query = search.toString();
  return `${API_THREADS_PATH}/${threadId}/snapshot${query ? `?${query}` : ""}`;
}

export function apiThreadsWsPath(): string {
  return API_THREADS_WS_PATH;
}
