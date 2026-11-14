import type { AgentCatalogItem, AgentFileStatus } from "@meridian/contracts/agents";
import {
  agentBuiltinFileSchema,
  agentCatalogSchema,
  agentFilesSchema,
} from "@meridian/contracts/agents";
import { getJson } from "./http-client";

export async function listAgentCatalog(
  signal: AbortSignal,
  projectId?: string,
): Promise<AgentCatalogItem[]> {
  const query = projectId ? `?${new URLSearchParams({ projectId })}` : "";
  const catalog = await getJson(`/api/agents${query}`, { signal, schema: agentCatalogSchema });
  return catalog.agents;
}

export async function listAgentFiles(
  signal: AbortSignal,
  projectId: string,
): Promise<AgentFileStatus[]> {
  const query = new URLSearchParams({ projectId });
  return (await getJson(`/api/agents/files?${query}`, { signal, schema: agentFilesSchema })).files;
}

export async function readBuiltinAgentFile(signal: AbortSignal, path: string): Promise<string> {
  const query = new URLSearchParams({ path });
  return (await getJson(`/api/agents/builtin?${query}`, { signal, schema: agentBuiltinFileSchema }))
    .text;
}
