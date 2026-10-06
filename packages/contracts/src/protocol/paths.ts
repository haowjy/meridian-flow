/**
 * Purpose: Provides canonical API path constants and URL builders for Meridian project, thread, context, and Yjs endpoints.
 * Why independent: Route paths are a shared client/server protocol primitive and should not be duplicated inside app code.
 */
import { isWorkScopedProjectContextScheme, type ProjectContextTreeScheme } from "./http-types.js";

export type ProjectContextRequestOptions = {
  workId?: string | null;
};

function projectContextQuery(
  scheme: ProjectContextTreeScheme,
  opts?: ProjectContextRequestOptions,
): string {
  const workId = opts?.workId;
  if (isWorkScopedProjectContextScheme(scheme) && workId) {
    return `?workId=${encodeURIComponent(workId)}`;
  }
  return "";
}
export const API_PROJECTS_PATH = "/api/projects";

export const API_THREADS_PATH = "/api/threads";
export const API_THREADS_WS_PATH = "/api/threads/ws";
export const API_BILLING_PATH = "/api/billing";
export const API_ACCOUNT_SETTINGS_PATH = "/api/account/settings";
export const API_ACCOUNT_RECENT_DOCUMENTS_PATH = "/api/account/recent-documents";
export const API_AUTH_ME_PATH = "/api/auth/me";
export { YJS_WS_PATH_PREFIX, yjsWsPath } from "./yjs-ws.js";

export function apiProjectPath(projectId: string): string {
  return `${API_PROJECTS_PATH}/${projectId}`;
}

/** Recents are read inside a project: the landing that renders them is one. */
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
  if (isWorkScopedProjectContextScheme(scheme) && opts?.workId) query.set("workId", opts.workId);
  return `${apiProjectPath(projectId)}/context/${scheme}/address?${query}`;
}

export function apiProjectThreadsPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/threads`;
}

/** Resolves a live `cN`/`pN` thread handle within one project. */
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

export function apiProjectWorkingSetPath(projectId: string): string {
  return `${API_PROJECTS_PATH}/${projectId}/working-set`;
}

export function apiProjectWorkWriteModePath(projectId: string, workId: string): string {
  return `${apiProjectWorksPath(projectId)}/${workId}/write-mode`;
}

export function apiProjectWorkDraftsPath(projectId: string, workId: string): string {
  return `${apiProjectWorksPath(projectId)}/${workId}/drafts`;
}

export function apiProjectWorkDocumentDraftPath(
  projectId: string,
  workId: string,
  documentId: string,
): string {
  return `${apiProjectWorksPath(projectId)}/${workId}/documents/${documentId}/draft`;
}

export function apiProjectWorkDocumentDraftApplyPath(
  projectId: string,
  workId: string,
  documentId: string,
): string {
  return `${apiProjectWorkDocumentDraftPath(projectId, workId, documentId)}/apply`;
}

export function apiProjectWorkDocumentDraftDiscardPath(
  projectId: string,
  workId: string,
  documentId: string,
): string {
  return `${apiProjectWorkDocumentDraftPath(projectId, workId, documentId)}/discard`;
}

/** (user, project)-scoped UI preferences — user resolved from auth. */
export function apiProjectPreferencesPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/preferences`;
}

export function apiProjectContextCatalogPath(
  projectId: string,
  operation: "snapshot" | "changes" | "children" | "lookup",
): string {
  return `${apiProjectPath(projectId)}/context/catalog/${operation}`;
}

export function apiProjectContextCreatePath(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  opts?: ProjectContextRequestOptions,
): string {
  return `${apiProjectPath(projectId)}/context/${scheme}/create${projectContextQuery(scheme, opts)}`;
}

export function apiProjectContextCreateUntitledPath(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  opts?: ProjectContextRequestOptions,
): string {
  return `${apiProjectPath(projectId)}/context/${scheme}/create-untitled${projectContextQuery(scheme, opts)}`;
}

export function apiProjectContextReadPath(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  path: string,
  opts?: ProjectContextRequestOptions,
): string {
  const search = new URLSearchParams({ path });
  const workId = opts?.workId;
  if (isWorkScopedProjectContextScheme(scheme) && workId) {
    search.set("workId", workId);
  }
  return `${apiProjectPath(projectId)}/context/${scheme}/read?${search.toString()}`;
}

export function apiProjectContextMovePath(
  projectId: string,
  scheme: ProjectContextTreeScheme,
): string {
  return `${apiProjectPath(projectId)}/context/${scheme}/move`;
}

export function apiProjectContextOperationPath(projectId: string, operationId: string): string {
  return `${apiProjectPath(projectId)}/context/operations/${encodeURIComponent(operationId)}`;
}

export function apiProjectContextDeletePath(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  opts?: ProjectContextRequestOptions,
): string {
  return `${apiProjectPath(projectId)}/context/${scheme}/delete${projectContextQuery(scheme, opts)}`;
}

/** Internal document-link resolution: three spellings in, one document or none. */
export function apiProjectLinksResolvePath(projectId: string): string {
  return `${apiProjectPath(projectId)}/links/resolve`;
}

export function apiProjectContextKbImportPath(projectId: string): string {
  return `${apiProjectPath(projectId)}/context/kb/import`;
}

export function apiProjectContextKbImportDriveFixturePath(projectId: string): string {
  return `${apiProjectPath(projectId)}/context/kb/import-drive-fixture`;
}

export function apiThreadPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}`;
}

export function apiThreadTitlePath(threadId: string): string {
  return `${apiThreadPath(threadId)}/title`;
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

export const API_AVAILABLE_SKILLS_PATH = "/api/skills";

export function apiAvailableSkillsPath(input: {
  catalogEntryId: string;
  definitionRevisionId: string;
  projectId?: string | null;
}): string {
  const query = new URLSearchParams({
    catalogEntryId: input.catalogEntryId,
    definitionRevisionId: input.definitionRevisionId,
  });
  if (input.projectId) query.set("projectId", input.projectId);
  return `${API_AVAILABLE_SKILLS_PATH}?${query}`;
}

/** Durable identity used to reconcile or explicitly retire one message admission. */
export function apiThreadAdmissionPath(threadId: string, submissionId: string): string {
  return `${API_THREADS_PATH}/${threadId}/admissions/${encodeURIComponent(submissionId)}`;
}

export function apiThreadCancelPath(threadId: string, turnId: string): string {
  return `${API_THREADS_PATH}/${threadId}/turns/${turnId}/cancel`;
}

/** Writer `/compact` commands queued on a thread's inbox. */
export function apiThreadControlsPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/controls`;
}

export function apiThreadControlWithdrawPath(threadId: string, controlId: string): string {
  return `${API_THREADS_PATH}/${threadId}/controls/${encodeURIComponent(controlId)}/withdraw`;
}

export function apiThreadRecentDocumentsPath(threadId: string, opts?: { limit?: number }): string {
  const search = new URLSearchParams();
  if (opts?.limit != null) {
    search.set("limit", String(opts.limit));
  }
  const query = search.toString();
  return `${API_THREADS_PATH}/${threadId}/recent-documents${query ? `?${query}` : ""}`;
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

/** POST: the writer restores a document the agent deleted in this turn. */
export function apiThreadTurnRestoreDeletePath(threadId: string, turnId: string): string {
  return `${API_THREADS_PATH}/${threadId}/turns/${turnId}/restore-delete`;
}

/** POST: retry a latest failed reply under a client-minted assistant-turn id. */
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

/** POST: create-or-get a fork of the thread at a cutoff turn, under a client-minted id. */
export function apiThreadForkPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/fork`;
}

/** POST: create-or-get a handoff from the thread at a cutoff turn, under a client-minted id. */
export function apiThreadHandoffPath(threadId: string): string {
  return `${API_THREADS_PATH}/${threadId}/handoff`;
}

/** POST: retry the pending brief for a handoff destination under a client-minted seed id. */
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

/** Builds a paged transcript read URL; omitted query values use the server defaults. */
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

export function apiThreadsWsPath(): string {
  return API_THREADS_WS_PATH;
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
