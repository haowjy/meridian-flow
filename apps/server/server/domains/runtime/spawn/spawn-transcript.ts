/**
 * spawn-transcript — persist writer-facing spawn and report cards.
 *
 * Tool dispatch runs handlers and durable tool_result rows. This module upserts
 * helper-result / child-report custom cards onto the active turn. Background
 * helper-result-delivery uses the same HelperResultProps builder.
 */
import {
  buildChildReportComponentContent,
  buildHelperResultComponentContent,
  type ComponentBlockContent,
} from "@meridian/contracts/components";
import type { ThreadId } from "@meridian/contracts/runtime";
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

export async function persistCustomCard(
  transcript: SpawnTranscript,
  content: ComponentBlockContent,
  existing?: Block | null,
): Promise<Block> {
  const persisted = await persistAndAppendEvents(
    transcript.persistence,
    transcript.threadId,
    async () => {
      const block = contentForBlockInput({
        ...(existing ? { id: existing.id } : {}),
        turnId: transcript.turnId,
        blockType: "custom",
        sequence: existing?.sequence ?? transcript.blockSeqRef.value++,
        content,
        status: "complete",
      });
      return {
        result: localBlockFromEvent(block),
        events: [{ type: "block.upserted" as const, block }],
      };
    },
  );
  if (existing) {
    const index = transcript.allBlocks.findIndex((block) => block.id === existing.id);
    if (index >= 0) transcript.allBlocks[index] = persisted.result;
    else transcript.allBlocks.push(persisted.result);
  } else {
    transcript.allBlocks.push(persisted.result);
  }
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

export async function persistChildReportCard(
  transcript: SpawnTranscript,
  input: { summary: string },
): Promise<Block> {
  return persistCustomCard(transcript, buildChildReportComponentContent(input));
}
