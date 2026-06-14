import { createError } from "nitro/h3";
import type {
  ProjectResultRecord,
  ResultRepository,
} from "../domains/context/promotion/ports/result-repository.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";
import { objectStoreKeyFromStorageUrl } from "../domains/storage/object-storage-url.js";
import type { ObjectStorePort } from "../domains/storage/ports/object-store.js";

export interface ProjectResultListItem {
  id: string;
  projectId: string;
  workspacePath: string;
  resultsUri: string;
  mimeType: string;
  sizeBytes: number;
  rootThreadId: string;
  threadId: string;
  turnId: string;
  toolCallId: string | null;
  agentSlug: string;
  createdAt: string;
}
export interface ListProjectResultsResponse {
  results: ProjectResultListItem[];
}
export interface ProjectResultSignedUrlResponse {
  resultId: string;
  signedUrl: string;
  mimeType: string;
  sizeBytes: number;
}
export interface ProjectResultsRouteDeps {
  projectRepo: ProjectRepository;
  results: ResultRepository;
}
export interface ProjectResultsRouteInput {
  projectId: string;
  userId: string;
}
export interface ProjectResultSignedUrlInput extends ProjectResultsRouteInput {
  resultId: string;
}
export interface ProjectResultSignedUrlDeps extends ProjectResultsRouteDeps {
  objectStore: ObjectStorePort;
}

function toListItem(row: ProjectResultRecord): ProjectResultListItem {
  return {
    id: row.id,
    projectId: row.projectId,
    workspacePath: row.sourcePath,
    resultsUri: row.resultsUri,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    rootThreadId: row.provenance.rootThreadId,
    threadId: row.provenance.threadId,
    turnId: row.provenance.turnId,
    toolCallId: row.provenance.toolCallId,
    agentSlug: row.provenance.agentSlug,
    createdAt: row.createdAt,
  };
}
export async function handleListProjectResultsRequest(
  deps: ProjectResultsRouteDeps,
  input: ProjectResultsRouteInput,
): Promise<ListProjectResultsResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const rows = await deps.results.listByProject(input.projectId);
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { results: rows.map(toListItem) };
}
export async function handleProjectResultSignedUrlRequest(
  deps: ProjectResultSignedUrlDeps,
  input: ProjectResultSignedUrlInput,
): Promise<ProjectResultSignedUrlResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const record = (await deps.results.listByProject(input.projectId)).find(
    (row) => row.id === input.resultId,
  );
  if (!record) throw createError({ statusCode: 404, message: "Result not found" });
  const key = objectStoreKeyFromStorageUrl(record.storageUrl);
  if (!key) throw createError({ statusCode: 502, message: "Result storage URL is invalid" });
  const signed = await deps.objectStore.getSignedUrl(key);
  if (!signed.ok) throw createError({ statusCode: 502, message: signed.error.message });
  return {
    resultId: record.id,
    signedUrl: signed.value,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
  };
}
