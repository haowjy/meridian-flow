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
  type ThreadRepositories,
} from "../../threads/index.js";
import { type PersistenceDeps, persistAndAppendEvents } from "./persistence.js";

type ComposePromptBake = Omit<PromptBakeContent, "contentHash">;

export interface BoundaryCompletion {
  blocks: BlockUpsertedRow[];
  metadata?: JsonValue | null;
  modelResponses?: ModelResponseReceivedRow[];
  completedAt?: string;
  finishReason?: Turn["finishReason"];
  /** Caller-owned visible history event, such as `context.compacted`. */
  events?: OrchestratorEvent[];
}

export type BeginPromptEpochInput = {
  threadId: ThreadId;
  cause: "compaction" | "compaction_undo";
  bake: { compose: ComposePromptBake } | { reuse: PromptBakeId };
  boundaryTurnId: TurnId;
  completion: BoundaryCompletion;
};

type BeginPromptEpochDeps = Omit<PersistenceDeps, "repos"> & {
  repos: PersistenceDeps["repos"] & Pick<ThreadRepositories, "promptBakes">;
};

/** Hashes or reuses a bake and completes the pending boundary in one journaled transaction. */
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
    const completedAt = input.completion.completedAt ?? new Date().toISOString();
    const completedTurn: Turn = {
      ...boundary,
      status: "complete",
      finishReason: input.completion.finishReason ?? "end_turn",
      completedAt,
      error: null,
      promptBakeId: bake.id,
      metadata:
        input.completion.metadata === undefined ? boundary.metadata : input.completion.metadata,
    };
    const events: OrchestratorEvent[] = [
      ...input.completion.blocks.map(
        (block): OrchestratorEvent => ({ type: "block.upserted", block }),
      ),
      { type: "turn.completed", turn: completedTurn },
      ...(input.completion.modelResponses ?? []).map(
        (response): OrchestratorEvent => ({ type: "model.response_received", response }),
      ),
      ...(input.completion.events ?? []),
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
  if ("reuse" in input.bake) {
    const bake = await deps.repos.promptBakes.findById(input.bake.reuse);
    if (!bake) throw new Error(`Prompt bake not found: ${input.bake.reuse}`);
    return bake;
  }

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
