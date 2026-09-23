/**
 * spawn-transcript — persist writer-facing spawn status cards and return_result tool settlement.
 *
 * Tool dispatch runs handlers and durable tool_result rows. This module upserts
 * helper-result custom cards onto the active turn and owns return_result
 * settlement. The accepted capture and ordinary tool_result share one
 * persistence transaction; capture is candidate content, not a terminal card.
 */
import {
  buildHelperResultComponentContent,
  type ComponentBlockContent,
} from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ReturnResultCapture, ReturnResultOutcome } from "@meridian/contracts/spawn";
import type { Block, OrchestratorEvent } from "@meridian/contracts/threads";
import { ExecutionReportConflictError } from "../../threads/index.js";
import type { ExecutionReportRepository } from "../../threads/ports/repositories.js";
import { contentForBlockInput, localBlockFromEvent } from "../loop/block-helpers.js";
import { type PersistenceDeps, persistAndAppendEvents } from "../loop/persistence.js";
import { spawnHelperCardProps } from "./spawn-output.js";

export type SpawnTranscript = {
  persistence: PersistenceDeps;
  threadId: ThreadId;
  turnId: string;
  blockSeqRef: { value: number };
  allBlocks: Block[];
  events: OrchestratorEvent[];
};

function customCardBlock(
  transcript: SpawnTranscript,
  content: ComponentBlockContent,
  existing?: Block | null,
) {
  const block = contentForBlockInput({
    ...(existing ? { id: existing.id } : {}),
    turnId: transcript.turnId,
    blockType: "custom",
    sequence: existing?.sequence ?? transcript.blockSeqRef.value++,
    content,
    status: "complete",
  });
  return { row: block, local: localBlockFromEvent(block) };
}

function rememberBlock(transcript: SpawnTranscript, local: Block, existing?: Block | null): void {
  if (existing) {
    const index = transcript.allBlocks.findIndex((block) => block.id === existing.id);
    if (index >= 0) transcript.allBlocks[index] = local;
    else transcript.allBlocks.push(local);
    return;
  }
  transcript.allBlocks.push(local);
}

export async function persistCustomCard(
  transcript: SpawnTranscript,
  content: ComponentBlockContent,
  existing?: Block | null,
): Promise<Block> {
  const persisted = await persistAndAppendEvents(
    transcript.persistence,
    transcript.threadId,
    async () => {
      const card = customCardBlock(transcript, content, existing);
      return {
        result: card.local,
        events: [{ type: "block.upserted" as const, block: card.row }],
      };
    },
  );
  rememberBlock(transcript, persisted.result, existing);
  transcript.events.push(...persisted.events);
  return persisted.result;
}

export async function persistHelperCard(
  transcript: SpawnTranscript | undefined,
  input: Parameters<typeof spawnHelperCardProps>[0],
  existing?: Block | null,
): Promise<Block | null> {
  if (!transcript) return existing ?? null;
  return persistCustomCard(
    transcript,
    buildHelperResultComponentContent(spawnHelperCardProps(input)),
    existing,
  );
}

export async function persistReturnResult(
  transcript: SpawnTranscript,
  input: {
    toolCallId: string;
    outcome: ReturnResultOutcome;
    capture: ReturnResultCapture | undefined;
    executionReports: Pick<ExecutionReportRepository, "captureOnce">;
  },
): Promise<{ block: Block; endTurn: boolean }> {
  const persisted = await persistAndAppendEvents(
    transcript.persistence,
    transcript.threadId,
    async () => {
      let output = input.outcome;
      if (output.ok) {
        if (!input.capture) throw new Error("Accepted return_result has no capture");
        try {
          await input.executionReports.captureOnce(
            transcript.threadId,
            transcript.turnId as TurnId,
            input.toolCallId,
            input.capture,
          );
        } catch (error) {
          if (!(error instanceof ExecutionReportConflictError)) throw error;
          output = { ok: false, message: error.message };
        }
      }
      const isError = !output.ok;
      const toolRow = contentForBlockInput({
        turnId: transcript.turnId,
        blockType: "tool_result",
        sequence: transcript.blockSeqRef.value++,
        content: {
          toolCallId: input.toolCallId,
          output,
          isError,
        },
        status: "complete",
      });
      const events: OrchestratorEvent[] = [
        { type: "block.upserted" as const, block: toolRow },
        {
          type: "tool.result" as const,
          toolCallId: input.toolCallId,
          output,
          isError,
        },
      ];
      return {
        result: { tool: localBlockFromEvent(toolRow), endTurn: output.ok },
        events,
      };
    },
  );
  rememberBlock(transcript, persisted.result.tool);
  transcript.events.push(...persisted.events);
  return { block: persisted.result.tool, endTurn: persisted.result.endTurn };
}
