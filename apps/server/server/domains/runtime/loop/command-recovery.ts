import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, Turn } from "@meridian/contracts/threads";
import { ToolCallPairing } from "@meridian-flow/gateway";
import { modelEditIds } from "../../../shared/model-edit-ids.js";
import { testHook } from "../../../shared/test-hooks.js";
import type { CommandResolver } from "../ports/command-resolver.js";
import { didNotRunResult, type ToolRegistry } from "../tools/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { type PersistenceDeps, persistAndAppendEvents } from "./persistence.js";

/**
 * Answers the document commands an assistant turn left open. A model response whose process died
 * can hold `tool_use` blocks for effectful calls that never got their result: the edit may have
 * committed, may be committing, or never started. Each one is resolved under its key and its
 * result block is stored, in call order, under the id the loop would have used.
 *
 * Runs inside the finalizer's thread-lock transaction under the caller's session claim, so no
 * lease check: nothing else can store a block for this turn. Other tools' unanswered calls keep
 * the request-time stub (`context-builder.ts`): nothing can run for them later.
 */
export function createCommandRecovery(deps: {
  repos: PersistenceDeps["repos"];
  eventWriter: PersistenceDeps["eventWriter"];
  toolRegistry: Pick<ToolRegistry, "getRegistration">;
  commands: CommandResolver;
}) {
  return async (threadId: ThreadId, turn: Turn): Promise<void> => {
    const blocks = await deps.repos.blocks.listByTurn(turn.id);
    const calls = new ToolCallPairing<Block>();
    for (const block of [...blocks].sort((a, b) => a.sequence - b.sequence)) {
      const { toolCallId } = block.content as { toolCallId?: string };
      if (toolCallId === undefined) continue;
      if (block.blockType === "tool_use") calls.call(toolCallId, block);
      else if (block.blockType === "tool_result") calls.answer(toolCallId);
    }
    const open = calls.unanswered().flatMap((block) => {
      const { toolCallId, toolName } = block.content as { toolCallId: string; toolName: string };
      if (!block.responseId || !deps.toolRegistry.getRegistration(toolName)?.documentCommand)
        return [];
      // The command's identity is the response and the id: a call id is the model's per response.
      return [{ key: { responseId: block.responseId, toolCallId }, toolCallId }];
    });
    if (open.length === 0) return;
    const thread = await deps.repos.threads.findByIdIncludingDeleted(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    let sequence = Math.max(...blocks.map((block) => block.sequence)) + 1;
    for (const { key: callKey, toolCallId } of open) {
      const key = {
        ...callKey,
        threadId,
        accountId: thread.userId,
        projectId: thread.projectId,
      };
      await testHook("recovery.beforeResolve");
      const outcome = await deps.commands.resolveCommand(key);
      const toolResult =
        outcome.status === "never" ? didNotRunResult(toolCallId) : outcome.result.toolResult;
      const { content, result, isError, metadata } = toolResult;
      const block = contentForBlockInput({
        id: modelEditIds(key).blockId,
        turnId: turn.id,
        blockType: "tool_result",
        sequence: sequence++,
        content: {
          toolCallId,
          content,
          result,
          ...(isError !== undefined ? { isError } : {}),
          ...(metadata ? { metadata } : {}),
        },
        status: "complete",
      });
      await persistAndAppendEvents(deps, threadId, async () => ({
        result: localBlockFromEvent(block),
        events: [
          { type: "block.upserted", block },
          { type: "tool.result", toolCallId, content, result, isError },
        ],
      }));
    }
  };
}
