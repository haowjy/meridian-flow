/**
 * Route core for GET /api/threads/:threadId/debug/turn-context-preview — owner-gated
 * read-only preview of the next turn's model context (system prompt, tools, gateway params).
 */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { TurnContextPreview } from "@meridian/contracts/threads";
import type { PackageRepository } from "../domains/packages/index.js";
import { assembleNextTurnContext } from "../domains/runtime/loop/turn-context-assembly.js";
import type { ModelRequestDebugStore } from "../domains/runtime/model-request-debug/index.js";
import type { ToolExecutor, ToolRegistry } from "../domains/runtime/tools/index.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { ThreadRepositories } from "./compose.js";
import { throwHttpInterruptForStatus } from "./interrupt-boundary.js";

export interface TurnContextPreviewRouteDeps {
  repos: Pick<ThreadRepositories, "threads" | "turns" | "blocks">;
  workbenchRepo: Parameters<typeof requireThreadOwner>[0]["workbenches"];
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

  await requireThreadOwner(
    { threads: deps.repos.threads, workbenches: deps.workbenchRepo },
    input.threadId,
    input.userId,
  );

  const thread = await deps.repos.threads.findById(input.threadId as ThreadId);
  if (!thread) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }

  const [turns, blocks] = await Promise.all([
    deps.repos.turns.listByThread(input.threadId as ThreadId),
    deps.repos.blocks.listByThread(input.threadId as ThreadId),
  ]);

  const assembled = await assembleNextTurnContext({
    thread,
    turns,
    blocks,
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
