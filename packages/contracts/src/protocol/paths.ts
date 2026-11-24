import { isOwnedContextScheme } from "../context-uri.js";
import type { ContextOwner } from "./context-owner.js";
import type { ProjectContextTreeScheme } from "./http-types.js";

export type ProjectContextRequestOptions = ContextOwner;

function setOwnerQuery(
  query: URLSearchParams,
  scheme: ProjectContextTreeScheme,
  opts?: ProjectContextRequestOptions,
): void {
  if (!isOwnedContextScheme(scheme)) return;
  if (scheme === "uploads") {
    if (opts?.chatThreadId) query.set("chatId", opts.chatThreadId);
  } else if (opts?.rootThreadId) query.set("rootThreadId", opts.rootThreadId);
  else if (opts?.workId) query.set("workId", opts.workId);
}

export const API_PROJECTS_PATH = "/api/projects";

export const API_THREADS_PATH = "/api/threads";
export const API_THREADS_WS_PATH = "/api/threads/ws";
export const API_BILLING_PATH = "/api/billing";
export const API_ACCOUNT_SETTINGS_PATH = "/api/account/settings";
export const API_ACCOUNT_CONTEXT_SOURCES_PATH = "/api/account/context-sources";
export const API_ACCOUNT_RECENT_DOCUMENTS_PATH = "/api/account/recent-documents";
export const API_AUTH_ME_PATH = "/api/auth/me";

export function apiProjectPath(projectId: string): string {
  return `${API_PROJECTS_PATH}/${projectId}`;
}

export function apiProjectRecentDocumentsPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/recent-documents`;
}

export function apiProjectDocumentAddressPath(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  path: string,
  opts?: ProjectContextRequestOptions,
): string {
  const query = new URLSearchParams({ path });
  setOwnerQuery(query, scheme, opts);
  return `${apiProjectPath(projectId)}/context/${scheme}/address?${query}`;
}

export function apiProjectThreadsPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/threads`;
}

export function apiProjectThreadByRefPath(projectId: string, ref: string): string {
  return `${apiProjectThreadsPath(projectId)}/by-ref/${encodeURIComponent(ref)}`;
}

export type ProjectChatFeedRequestOptions = {
  cursor?: string | null;
  favorite?: boolean;
  search?: string | null;
  workId?: string | null;
};

export function apiProjectChatFeedPath(
  projectId: string,
  opts?: ProjectChatFeedRequestOptions,
): string {
  const query = new URLSearchParams();
  if (opts?.cursor) query.set("cursor", opts.cursor);
  if (opts?.favorite) query.set("favorite", "true");
  if (opts?.search) query.set("q", opts.search);
  if (opts?.workId) query.set("workId", opts.workId);
  const queryString = query.toString();
  return `${apiProjectPath(projectId)}/chat-feed${queryString ? `?${queryString}` : ""}`;
}

export function apiThreadUserStatePath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/user-state`;
}

export function apiProjectWorksPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/works`;
}

export function apiProjectDocumentDraftsPath(projectId: string, documentId: string): string {
  return `${apiProjectPath(projectId)}/documents/${documentId}/drafts`;
}

export function apiProjectDraftsPath(projectId: string, draft: string): string {
  return `${apiProjectPath(projectId)}/drafts?draft=${encodeURIComponent(draft)}`;
}

export function apiProjectContextLineagePath(projectId: string, rootThreadId: string): string {
  return `${apiProjectPath(projectId)}/context/lineages/${encodeURIComponent(rootThreadId)}`;
}

export function apiProjectContextSourcesPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/context/sources`;
}

export function apiProjectDocumentReadPath(projectId: string, documentId: string): string {
  return `${apiProjectPath(projectId)}/documents/${documentId}/read`;
}

export function apiProjectContextCopyPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/context/copy`;
}

export function apiProjectLinksResolvePath(projectId: string): string {
  return `${apiProjectPath(projectId)}/links/resolve`;
}

export function apiThreadPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}`;
}

export function apiThreadRestorePath(threadId: string): string {
  return `${apiThreadPath(threadId)}/restore`;
}

export function apiThreadTitlePath(threadId: string): string {
  return `${apiThreadPath(threadId)}/title`;
}

export function apiThreadOverridesPath(threadId: string): string {
  return `${apiThreadPath(threadId)}/overrides`;
}

export function apiThreadWorkPath(threadId: string): string {
  return `${apiThreadPath(threadId)}/work`;
}

export function apiThreadMessagePath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/messages`;
}

export function apiThreadSkillsPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/skills`;
}

export function apiThreadAgentPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/agent`;
}

export const API_AVAILABLE_SKILLS_PATH = "/api/skills";

export function apiAvailableSkillsPath(input: { projectId?: string | null }): string {
  return input.projectId
    ? `${API_AVAILABLE_SKILLS_PATH}?${new URLSearchParams({ projectId: input.projectId })}`
    : API_AVAILABLE_SKILLS_PATH;
}

export function apiThreadAdmissionPath(threadId: string, submissionId: string): string {
  return `${API_THREADS_PATH}/${threadId}/admissions/${encodeURIComponent(submissionId)}`;
}

export function apiThreadCancelPath(threadId: string, turnId: string): string {
  return `${API_THREADS_PATH}/${threadId}/turns/${turnId}/cancel`;
}

export function apiThreadStopPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/stop`;
}

export function apiThreadHandBackPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/hand-back`;
}

export function apiThreadSendNowPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/send-now`;
}

export function apiThreadControlsPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/controls`;
}

export function apiThreadControlWithdrawPath(threadId: string, controlId: string): string {
  return `${API_THREADS_PATH}/${threadId}/controls/${encodeURIComponent(controlId)}/withdraw`;
}

export function apiAccountRecentDocumentsPath(): string {
  return API_ACCOUNT_RECENT_DOCUMENTS_PATH;
}

export function apiThreadContextReversePath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/context/reverse`;
}

export function apiThreadTurnLiveLineagePath(threadId: string, turnId: string): string {
  return `${API_THREADS_PATH}/${threadId}/turns/${turnId}/live-lineage`;
}

export function apiThreadTurnRetryPath(threadId: string, turnId: string): string {
  return `${API_THREADS_PATH}/${threadId}/turns/${turnId}/retry`;
}

export type ModelRequestDebugQuery = {
  turnId?: string;
  iteration?: number;
  gatewayCallId?: string;
  latest?: boolean;
};

export function apiThreadModelRequestsDebugPath(
  threadId: string,
  opts?: ModelRequestDebugQuery,
): string {
  const search = new URLSearchParams();
  if (opts?.turnId) search.set("turnId", opts.turnId);
  if (opts?.iteration !== undefined) search.set("iteration", String(opts.iteration));
  if (opts?.gatewayCallId) search.set("gatewayCallId", opts.gatewayCallId);
  if (opts?.latest) search.set("latest", "1");
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

export function apiThreadForkPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/fork`;
}

export function apiThreadHandoffPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/handoff`;
}

export function apiThreadHandoffBriefPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/handoff/brief`;
}

export type TranscriptPagePathOptions = {
  order?: "newest_first" | "oldest_first";
  unit?: "item" | "turn";
  limit?: number;
  cursor?: string;
  range?: "effective" | "inherited";
};

export function apiThreadTranscriptPath(
  threadId: string,
  opts?: TranscriptPagePathOptions,
): string {
  const query = new URLSearchParams();
  if (opts?.order) query.set("order", opts.order);
  if (opts?.unit) query.set("unit", opts.unit);
  if (opts?.limit !== undefined) query.set("limit", String(opts.limit));
  if (opts?.cursor) query.set("cursor", opts.cursor);
  if (opts?.range) query.set("range", opts.range);
  const search = query.toString();
  return `${API_THREADS_PATH}/${threadId}/transcript${search ? `?${search}` : ""}`;
}

export function apiBillingBalancePath(): string {
  return `${API_BILLING_PATH}/balance`;
}

export function apiBillingTransactionsPath(): string {
  return `${API_BILLING_PATH}/transactions`;
}

export function apiBillingProductsPath(): string {
  return `${API_BILLING_PATH}/products`;
}

export function apiBillingCheckoutSessionsPath(): string {
  return `${API_BILLING_PATH}/checkout-sessions`;
}

export function apiThreadExecutionReportPath(
  threadId: string,
  childThreadId: string,
  execution: string,
): string {
  return `${API_THREADS_PATH}/${threadId}/reports/${childThreadId}/${execution}`;
}
