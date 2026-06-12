// @ts-nocheck
/**
 * workbench-results-api — typed HTTP client for the Results rail.
 *
 * Mirrors the server-side response shapes defined in
 * `apps/server/server/lib/workbench-results-route.ts`. The types are
 * declared locally (rather than imported from `@meridian/contracts`) because
 * the Results surface has not been promoted into the shared contracts
 * package yet — promote when the wire shape stabilizes.
 */
import { getJson } from "./http-client";

export interface WorkbenchResultItem {
  id: string;
  workbenchId: string;
  workspacePath: string;
  resultsUri: string;
  mimeType: string;
  sizeBytes: number;
  /** Top-of-chain thread that owns the promoted artifact. */
  rootThreadId: string;
  /** Producing thread — destination of "open producing turn" navigation. */
  threadId: string;
  /** Producing turn — anchor target inside the thread (see anchor note in rail). */
  turnId: string;
  /** Tool call id if the artifact came out of a tool invocation; null when produced inline. */
  toolCallId: string | null;
  /** Display attribution — `Thread.currentAgent` slug at promotion time. */
  agentSlug: string;
  createdAt: string;
}

export interface ListWorkbenchResultsResponse {
  results: WorkbenchResultItem[];
}

export interface WorkbenchResultSignedUrlResponse {
  resultId: string;
  signedUrl: string;
  mimeType: string;
  sizeBytes: number;
}

export function workbenchResultsPath(workbenchId: string): string {
  return `/api/workbenches/${workbenchId}/results`;
}

export function workbenchResultSignedUrlPath(workbenchId: string, resultId: string): string {
  return `/api/workbenches/${workbenchId}/results/${resultId}/signed-url`;
}

export async function listWorkbenchResults(workbenchId: string): Promise<WorkbenchResultItem[]> {
  const response = await getJson<ListWorkbenchResultsResponse>(workbenchResultsPath(workbenchId));
  return response.results;
}

export async function getWorkbenchResultSignedUrl(
  workbenchId: string,
  resultId: string,
): Promise<WorkbenchResultSignedUrlResponse> {
  return getJson<WorkbenchResultSignedUrlResponse>(
    workbenchResultSignedUrlPath(workbenchId, resultId),
  );
}
