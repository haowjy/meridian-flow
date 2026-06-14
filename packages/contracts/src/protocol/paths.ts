/**
 * Purpose: Provides canonical API path constants and URL builders for Meridian project, thread, context, and Yjs endpoints.
 * Why independent: Route paths are a shared client/server protocol primitive and should not be duplicated inside app code.
 */
import type { ProjectContextTreeScheme } from "./http-types.js";
export const API_PROJECTS_PATH = "/api/projects";

export const API_THREADS_PATH = "/api/threads";
export const API_THREADS_WS_PATH = "/api/threads/ws";
export const API_BILLING_PATH = "/api/billing";
export const API_ONBOARDING_PATH = "/api/onboarding";
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

/** (user, project)-scoped UI preferences — user resolved from auth. */
export function apiProjectPreferencesPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/preferences`;
}

/** Selectable agent catalog for composer picker and Library. */
export function apiProjectAgentsPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/agents`;
}

export function apiProjectContextTreePath(
  projectId: string,
  scheme: ProjectContextTreeScheme,
): string {
  return `${apiProjectPath(projectId)}/context/${scheme}/tree`;
}

export function apiProjectContextCreatePath(
  projectId: string,
  scheme: ProjectContextTreeScheme,
): string {
  return `${apiProjectPath(projectId)}/context/${scheme}/create`;
}

export function apiProjectContextReadPath(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  path: string,
): string {
  return `${apiProjectPath(projectId)}/context/${scheme}/read?path=${encodeURIComponent(path)}`;
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

export function apiBillingBalancePath(): string {
  return `${API_BILLING_PATH}/balance`;
}

export function apiBillingTransactionsPath(): string {
  return `${API_BILLING_PATH}/transactions`;
}

export function apiBillingPacksPath(): string {
  return `${API_BILLING_PATH}/packs`;
}

export function apiBillingCheckoutSessionsPath(): string {
  return `${API_BILLING_PATH}/checkout-sessions`;
}

export function apiOnboardingPath(): string {
  return API_ONBOARDING_PATH;
}

export function apiOnboardingProgressPath(): string {
  return `${API_ONBOARDING_PATH}/progress`;
}

export function apiOnboardingCompletePath(): string {
  return `${API_ONBOARDING_PATH}/complete`;
}
