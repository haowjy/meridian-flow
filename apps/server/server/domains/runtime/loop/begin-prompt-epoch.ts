/** Complete one reserved turn as an immutable prompt-epoch boundary. */

import type { PromptBakeId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  BlockUpsertedRow,
  JsonValue,
  ModelResponseReceivedRow,
  OrchestratorEvent,
  PromptBake,
  Thread,
  Turn,
} from "@meridian/contracts/threads";
import {
  bakeInEffect,
  hashPromptBakeContent,
  type PromptBakeContent,
  promptEpochMetadata,
  type ThreadRepositories,
} from "../../threads/index.js";
import { type PersistenceDeps, persistAndAppendEvents } from "./persistence.js";

type ComposePromptBake = Omit<PromptBakeContent, "contentHash">;

export interface BoundaryCompletion {
  blocks: BlockUpsertedRow[];
  compactionModel?: string;
  metadata?: JsonValue | null;
  modelResponses?: ModelResponseReceivedRow[];
  /** Caller-owned visible history event, such as `context.compacted`. */
  events?: (bakeId: PromptBakeId) => OrchestratorEvent[];
}

export type BeginPromptEpochInput = {
  threadId: ThreadId;
  bake: { compose: ComposePromptBake };
  boundaryTurnId: TurnId;
  completion: BoundaryCompletion;
};

type BeginPromptEpochDeps = Omit<PersistenceDeps, "repos"> & {
  repos: PersistenceDeps["repos"] & Pick<ThreadRepositories, "promptBakes">;
};

/** Hashes a bake and completes the pending boundary in one journaled transaction. */
export async function beginPromptEpoch(
  deps: BeginPromptEpochDeps,
  input: BeginPromptEpochInput,
): Promise<{ bakeId: PromptBakeId }> {
  const { result } = await persistAndAppendEvents(deps, input.threadId, async () => {
    const thread = await deps.repos.threads.lockByIdIncludingDeleted(input.threadId);
    if (!thread || thread.deletedAt) throw new Error(`Thread not found: ${input.threadId}`);

    const boundary = await deps.repos.turns.findById(input.boundaryTurnId);
    if (!boundary || boundary.threadId !== input.threadId)
      throw new Error(`Boundary turn is not in thread ${input.threadId}`);
    if (boundary.status !== "pending")
      throw new Error(`Boundary turn ${input.boundaryTurnId} is not pending`);
    if (boundary.promptBakeId != null)
      throw new Error(`Boundary turn ${input.boundaryTurnId} already has a prompt bake`);

    const bake = await resolveBake(deps, input, thread);
    const completionMetadata =
      input.completion.metadata === undefined ? boundary.metadata : input.completion.metadata;
    const completedTurn: Turn = {
      ...boundary,
      status: "complete",
      finishReason: "end_turn",
      completedAt: new Date().toISOString(),
      error: null,
      promptBakeId: bake.id,
      compactionModel: input.completion.compactionModel ?? null,
      metadata: promptEpochMetadata(completionMetadata),
    };
    const events: OrchestratorEvent[] = [
      ...input.completion.blocks.map(
        (block): OrchestratorEvent => ({ type: "block.upserted", block }),
      ),
      { type: "turn.completed", turn: completedTurn },
      ...(input.completion.modelResponses ?? []).map(
        (response): OrchestratorEvent => ({ type: "model.response_received", response }),
      ),
      ...(input.completion.events?.(bake.id) ?? []),
    ];
    return { result: { bakeId: bake.id }, events };
  });
  return result;
}

async function resolveBake(
  deps: BeginPromptEpochDeps,
  input: BeginPromptEpochInput,
  thread: Thread,
): Promise<PromptBake> {
  const content = input.bake.compose;
  const contentHash = hashPromptBakeContent(content);
  const current = await bakeInEffect(
    {
      threads: deps.repos.threads,
      turns: deps.repos.turns,
      promptBakes: deps.repos.promptBakes,
    },
    thread,
  );
  if (current?.contentHash === contentHash) return current;
  return deps.repos.promptBakes.create({
    ownerThreadId: input.threadId,
    ...content,
    contentHash,
  });
}
