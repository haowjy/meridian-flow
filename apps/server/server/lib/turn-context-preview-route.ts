/**
 * Route core for GET /api/threads/:threadId/debug/turn-context-preview — owner-gated
 * read-only preview of the next turn's model context (system prompt, tools, gateway params).
 */

import type { TurnContextPreview } from "@meridian/contracts/threads";
import type { AgentRevisionStore } from "../domains/packages/index.js";
import { assembleNextTurnContext } from "../domains/runtime/loop/turn-context-assembly.js";
import type { WorkContextReader } from "../domains/runtime/loop/work-context.js";
import type { ModelRequestDebugStore } from "../domains/runtime/model-request-debug/index.js";
import type { ToolExecutor, ToolRegistry } from "../domains/runtime/tools/index.js";
import {
  loadThreadConversationContext,
  requireThreadOwner,
  ThreadConversationContextError,
} from "../domains/threads/index.js";
import type { ThreadRepositories } from "./compose.js";
import { throwHttpInterruptForStatus } from "./interrupt-boundary.js";

export interface TurnContextPreviewRouteDeps {
  repos: Pick<ThreadRepositories, "threads" | "turns" | "blocks">;
  projectRepo: Parameters<typeof requireThreadOwner>[0]["projects"];
  modelRequestDebug: ModelRequestDebugStore;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource" | "readRevision">;
  toolRegistry: ToolRegistry;
  toolExecutor: Pick<ToolExecutor, "getDefinitions">;
  workContext: WorkContextReader;
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

  let conversation: Awaited<ReturnType<typeof loadThreadConversationContext>>;
  try {
    conversation = await loadThreadConversationContext(
      {
        threads: deps.repos.threads,
        turns: deps.repos.turns,
        blocks: deps.repos.blocks,
      },
      thread,
    );
  } catch (error) {
    if (error instanceof ThreadConversationContextError) {
      throwHttpInterruptForStatus(409, error.message);
    }
    throw error;
  }

  const assembled = await assembleNextTurnContext({
    thread,
    turns: conversation.turns,
    blocks: conversation.blocks,
    agentRevisions: deps.agentRevisions,
    toolRegistry: deps.toolRegistry,
    baseTools: deps.toolExecutor.getDefinitions?.(),
    persistBake: false,
    workContext: deps.workContext,
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
