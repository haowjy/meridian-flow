import type {
  AgentCatalogItem,
  AgentFiles,
  AgentsLevel,
  SaveAgentsRequest,
  SaveOutcome,
  ThreadAgent,
} from "@meridian/contracts/agents";
import {
  agentBuiltinFileSchema,
  agentCatalogSchema,
  agentFilesSchema,
  saveAgentsResponseSchema,
  threadAgentSchema,
  undoSaveResponseSchema,
} from "@meridian/contracts/agents";
import { apiThreadAgentPath } from "@meridian/contracts/protocol";
import { getJson, postJson } from "./http-client";

export async function listAgentCatalog(
  signal: AbortSignal,
  projectId?: string,
): Promise<AgentCatalogItem[]> {
  const query = projectId ? `?${new URLSearchParams({ projectId })}` : "";
  const catalog = await getJson(`/api/agents${query}`, { signal, schema: agentCatalogSchema });
  return catalog.agents;
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

/** False when a later Save of the package exists: nothing changed. */
export async function undoAgentSave(
  projectId: string,
  level: AgentsLevel,
  saveId: string,
): Promise<boolean> {
  return (
    await postJson(
      "/api/agents/save/undo",
      { projectId, level, saveId },
      { schema: undoSaveResponseSchema },
    )
  ).undone;
}

export async function readBuiltinAgentFile(signal: AbortSignal, path: string): Promise<string> {
  const query = new URLSearchParams({ path });
  return (await getJson(`/api/agents/builtin?${query}`, { signal, schema: agentBuiltinFileSchema }))
    .text;
}

export function readThreadAgent(signal: AbortSignal, threadId: string): Promise<ThreadAgent> {
  return getJson(apiThreadAgentPath(threadId), { signal, schema: threadAgentSchema });
}
