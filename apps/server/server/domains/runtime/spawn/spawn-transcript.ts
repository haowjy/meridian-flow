/**
 * spawn-transcript — persist writer-facing spawn and report cards.
 *
 * Tool dispatch runs handlers and durable tool_result rows. This module upserts
 * helper-result custom cards onto the active turn and owns return_result
 * settlement (tool_result + child-report in one persist). Background
 * helper-result-delivery uses the same HelperResultProps builder.
 */
import {
  buildChildReportComponentContent,
  buildHelperResultComponentContent,
  type ComponentBlockContent,
} from "@meridian/contracts/components";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ReturnResultOutcome } from "@meridian/contracts/spawn";
import type { Block, OrchestratorEvent } from "@meridian/contracts/threads";
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

export async function persistSpawnHelperCard(
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
    summary: string;
  },
): Promise<{ block: Block; endTurn: boolean }> {
  const persisted = await persistAndAppendEvents(
    transcript.persistence,
    transcript.threadId,
    async () => {
      const output: { ok: true } | { ok: false; message: string } = input.outcome.ok
        ? { ok: true }
        : { ok: false, message: input.outcome.message };
      const isError = !input.outcome.ok;
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
      let card: Block | undefined;
      if (input.outcome.ok) {
        const report = customCardBlock(
          transcript,
          buildChildReportComponentContent({ summary: input.summary }),
        );
        events.push({ type: "block.upserted" as const, block: report.row });
        card = report.local;
      }
      return {
        result: { tool: localBlockFromEvent(toolRow), card },
        events,
      };
    },
  );
  rememberBlock(transcript, persisted.result.tool);
  if (persisted.result.card) rememberBlock(transcript, persisted.result.card);
  transcript.events.push(...persisted.events);
  return { block: persisted.result.tool, endTurn: input.outcome.ok };
}
