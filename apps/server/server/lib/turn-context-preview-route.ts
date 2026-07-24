/**
 * Route core for GET /api/threads/:threadId/debug/turn-context-preview — owner-gated
 * read-only preview of the next turn's model context (system prompt, tools, gateway params).
 */

import type { TurnContextPreview } from "@meridian/contracts/threads";
import type { PackageRepository } from "../domains/packages/index.js";
import { loadThreadConversationContext } from "../domains/runtime/loop/fork-thread-context.js";
import { assembleNextTurnContext } from "../domains/runtime/loop/turn-context-assembly.js";
import type { ModelRequestDebugStore } from "../domains/runtime/model-request-debug/index.js";
import type { ToolExecutor, ToolRegistry } from "../domains/runtime/tools/index.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { ThreadRepositories } from "./compose.js";
import { throwHttpInterruptForStatus } from "./interrupt-boundary.js";

export interface TurnContextPreviewRouteDeps {
  repos: Pick<ThreadRepositories, "threads" | "turns" | "blocks">;
  projectRepo: Parameters<typeof requireThreadOwner>[0]["projects"];
  modelRequestDebug: ModelRequestDebugStore;
  packageRepository: PackageRepository;
  toolRegistry: ToolRegistry;
  toolExecutor: Pick<ToolExecutor, "getDefinitions">;
}

export async function handleGetTurnContextPreview(
  deps: TurnContextPreviewRouteDeps,
  input: { threadId: string; userId: string },
): Promise<TurnContextPreview> {
  if (!deps.modelRequestDebug.captureEnabled) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }

  const thread = await requireThreadOwner(
    { threads: deps.repos.threads, projects: deps.projectRepo },
    input.threadId,
    input.userId,
  );

  const conversation = await loadThreadConversationContext(
    {
      threads: deps.repos.threads,
      turns: deps.repos.turns,
      blocks: deps.repos.blocks,
    },
    thread,
  );

  const assembled = await assembleNextTurnContext({
    thread,
    turns: conversation.turns,
    blocks: conversation.blocks,
    packageRepository: deps.packageRepository,
    toolRegistry: deps.toolRegistry,
    baseTools: deps.toolExecutor.getDefinitions?.(),
    persistBake: false,
  });

  return {
    agentSlug: assembled.agentSlug,
    systemPrompt: assembled.systemPrompt,
    baked: assembled.baked,
    tools: assembled.tools.map((tool) => ({
      type: tool.type,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as TurnContextPreview["tools"][number]["inputSchema"],
    })),
    gatewayParams: assembled.gatewayParams,
  };
}
