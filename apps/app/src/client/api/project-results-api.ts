/**
 * project-results-api — typed HTTP client for the Results rail.
 *
 * Mirrors the server-side response shapes defined in
 * `apps/server/server/lib/project-results-route.ts`. The types are
 * declared locally (rather than imported from `@meridian/contracts`) because
 * the Results surface has not been promoted into the shared contracts
 * package yet — promote when the wire shape stabilizes.
 */
import { getJson } from "./http-client";

export interface ProjectResultItem {
  id: string;
  projectId: string;
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

export interface ListProjectResultsResponse {
  results: ProjectResultItem[];
}

export interface ProjectResultSignedUrlResponse {
  resultId: string;
  signedUrl: string;
  mimeType: string;
  sizeBytes: number;
}

export function projectResultsPath(projectId: string): string {
  return `/api/projects/${projectId}/results`;
}

export function projectResultSignedUrlPath(projectId: string, resultId: string): string {
  return `/api/projects/${projectId}/results/${resultId}/signed-url`;
}

export async function listProjectResults(projectId: string): Promise<ProjectResultItem[]> {
  const response = await getJson<ListProjectResultsResponse>(projectResultsPath(projectId));
  return response.results;
}

export async function getProjectResultSignedUrl(
  projectId: string,
  resultId: string,
): Promise<ProjectResultSignedUrlResponse> {
  return getJson<ProjectResultSignedUrlResponse>(projectResultSignedUrlPath(projectId, resultId));
}
