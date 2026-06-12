import { createError } from "nitro/h3";
import type {
  ResultRepository,
  WorkbenchResultRecord,
} from "../domains/context/promotion/ports/result-repository.js";
import { objectStoreKeyFromStorageUrl } from "../domains/storage/object-storage-url.js";
import type { ObjectStorePort } from "../domains/storage/ports/object-store.js";
import { requireWorkbenchOwner, type WorkbenchRepository } from "../domains/workbenches/index.js";

export interface WorkbenchResultListItem {
  id: string;
  workbenchId: string;
  sourcePath: string;
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
export interface ListWorkbenchResultsResponse {
  results: WorkbenchResultListItem[];
}
export interface WorkbenchResultSignedUrlResponse {
  resultId: string;
  signedUrl: string;
  mimeType: string;
  sizeBytes: number;
}
export interface WorkbenchResultsRouteDeps {
  workbenchRepo: WorkbenchRepository;
  results: ResultRepository;
}
export interface WorkbenchResultsRouteInput {
  workbenchId: string;
  userId: string;
}
export interface WorkbenchResultSignedUrlInput extends WorkbenchResultsRouteInput {
  resultId: string;
}
export interface WorkbenchResultSignedUrlDeps extends WorkbenchResultsRouteDeps {
  objectStore: ObjectStorePort;
}

function toListItem(row: WorkbenchResultRecord): WorkbenchResultListItem {
  return {
    id: row.id,
    workbenchId: row.workbenchId,
    sourcePath: row.sourcePath,
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
export async function handleListWorkbenchResultsRequest(
  deps: WorkbenchResultsRouteDeps,
  input: WorkbenchResultsRouteInput,
): Promise<ListWorkbenchResultsResponse> {
  await requireWorkbenchOwner({ workbenches: deps.workbenchRepo }, input.workbenchId, input.userId);
  const rows = await deps.results.listByWorkbench(input.workbenchId);
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { results: rows.map(toListItem) };
}
export async function handleWorkbenchResultSignedUrlRequest(
  deps: WorkbenchResultSignedUrlDeps,
  input: WorkbenchResultSignedUrlInput,
): Promise<WorkbenchResultSignedUrlResponse> {
  await requireWorkbenchOwner({ workbenches: deps.workbenchRepo }, input.workbenchId, input.userId);
  const record = (await deps.results.listByWorkbench(input.workbenchId)).find(
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
