import type {
  AgentCatalog,
  AgentFiles,
  AgentLevel,
  AgentsLevel,
  SaveAgentsRequest,
  SaveOutcome,
  ThreadAgent,
} from "@meridian/contracts/agents";
import {
  agentCatalogSchema,
  agentFilesSchema,
  saveAgentsResponseSchema,
  savedAgentFileSchema,
  threadAgentSchema,
  undoSaveResponseSchema,
} from "@meridian/contracts/agents";
import { apiThreadAgentPath } from "@meridian/contracts/protocol";
import { getJson, postJson } from "./http-client";

export async function listAgentCatalog(
  signal: AbortSignal,
  projectId?: string,
): Promise<AgentCatalog> {
  const query = projectId ? `?${new URLSearchParams({ projectId })}` : "";
  return getJson(`/api/agents${query}`, { signal, schema: agentCatalogSchema });
}

export async function listAgentFiles(signal: AbortSignal, projectId: string): Promise<AgentFiles> {
  const query = new URLSearchParams({ projectId });
  return getJson(`/api/agents/files?${query}`, { signal, schema: agentFilesSchema });
}

/** A package whose check fails comes back as a `failed` outcome, never as an HTTP error. */
export async function saveAgentPackages(
  projectId: string,
  packages: SaveAgentsRequest["packages"],
): Promise<SaveOutcome[]> {
  const body: SaveAgentsRequest = { projectId, packages };
  return (await postJson("/api/agents/save", body, { schema: saveAgentsResponseSchema })).outcomes;
}

/** The result distinguishes a repeated Undo from a superseded Save. */
export async function undoAgentSave(projectId: string, level: AgentsLevel, saveId: string) {
  return postJson(
    "/api/agents/save/undo",
    { projectId, level, saveId },
    { schema: undoSaveResponseSchema },
  );
}

/** A file's text as its package's latest Save holds it; a built-in's as shipped. */
export async function readSavedAgentFile(
  signal: AbortSignal,
  file: { projectId?: string; level: AgentLevel; path: string },
): Promise<string> {
  const { projectId, level, path } = file;
  const query = new URLSearchParams({ level, path, ...(projectId ? { projectId } : {}) });
  return (
    await getJson(`/api/agents/saved-file?${query}`, { signal, schema: savedAgentFileSchema })
  ).text;
}

export function readThreadAgent(signal: AbortSignal, threadId: string): Promise<ThreadAgent> {
  return getJson(apiThreadAgentPath(threadId), { signal, schema: threadAgentSchema });
}
