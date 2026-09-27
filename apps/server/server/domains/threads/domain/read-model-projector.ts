/**
 * Read-model projector: applies durable orchestrator events to thread read-model
 * tables. This is the in-transaction projection seam that makes event journal
 * facts the authority for model responses, blocks, and their rollups. When a
 * new user turn arrives, this projector clears only that turn's explicit
 * `prevTurnId` if it is an errored assistant turn: the append-only error event
 * remains journal truth, while the projected snapshot stops rendering a stale
 * error banner after the user moves on.
 */
import {
  type BlockUpsertedRow,
  blockPlainText,
  isTerminalTurnStatus,
  type ModelResponseReceivedRow,
  type OrchestratorEvent,
  type Turn,
} from "@meridian/contracts/threads";
import type {
  CreateBlockInput,
  CreateModelResponseInput,
  CreateTurnInput,
  ThreadRepositories,
  UpdateTurnStatusInput,
} from "../ports/repositories.js";

type ReadModelProjectorRepositories = Pick<
  ThreadRepositories,
  "blocks" | "imageInclusions" | "modelResponses" | "threads" | "turns"
>;

function responseToCreateInput(response: ModelResponseReceivedRow): CreateModelResponseInput {
  return {
    id: response.id,
    turnId: response.turnId,
    sequence: response.sequence,
    provider: response.provider,
    model: response.model,
    providerRequestId: response.providerRequestId ?? null,
    inputTokens: response.inputTokens ?? 0,
    outputTokens: response.outputTokens ?? 0,
    reasoningTokens: response.reasoningTokens ?? null,
    cacheReadTokens: response.cacheReadTokens ?? null,
    cacheWriteTokens: response.cacheWriteTokens ?? null,
    costUsd: response.costUsd ?? "0",
    millicredits: response.millicredits ?? null,
    priceSource: response.priceSource ?? "unknown",
    pricingSnapshot: response.pricingSnapshot ?? null,
    finishReason: response.finishReason ?? null,
    rawUsage: response.rawUsage ?? null,
    predictedCacheState: response.predictedCacheState ?? null,
    predictedCacheReason: response.predictedCacheReason ?? null,
  };
}

function blockToUpsertInput(block: BlockUpsertedRow): CreateBlockInput & { id: string } {
  return {
    id: block.id,
    turnId: block.turnId,
    responseId: block.responseId ?? null,
    blockType: block.blockType,
    sequence: block.sequence,
    content: block.content,
    textContent: blockPlainText(block.blockType, block.content),
    provider: block.provider ?? null,
    status: block.status,
  };
}

function turnToCreateInput(turn: Turn): CreateTurnInput {
  return {
    id: turn.id,
    threadId: turn.threadId,
    createdAt: turn.createdAt,
    prevTurnId: turn.prevTurnId ?? turn.parentTurnId ?? null,
    promptBakeId: turn.promptBakeId ?? null,
    role: turn.role,
    origin: turn.origin,
    writeMode: turn.writeMode,
    status: turn.status,
    requestParams: turn.requestParams ?? null,
    metadata: turn.metadata ?? null,
  };
}

function turnToLifecycleStatusUpdate(turn: Turn): UpdateTurnStatusInput {
  return {
    status: turn.status,
    finishReason: turn.finishReason,
    completedAt: turn.completedAt,
    error: turn.error,
    promptBakeId: turn.promptBakeId ?? null,
    metadata: turn.metadata ?? null,
  };
}

async function updateInterruptTurnStatus(
  repos: ReadModelProjectorRepositories,
  turnId: string,
  status: UpdateTurnStatusInput["status"],
): Promise<void> {
  const turn = await repos.turns.findById(turnId);
  if (!turn || isTerminalTurnStatus(turn.status)) return;
  await repos.turns.updateStatus(turnId, { status });
}

async function clearPreviousAssistantErrorIfUserTurn(
  repos: ReadModelProjectorRepositories,
  turn: Turn,
): Promise<void> {
  if (turn.role !== "user" || !turn.prevTurnId) return;
  const previousTurn = await repos.turns.findById(turn.prevTurnId);
  if (
    previousTurn?.threadId !== turn.threadId ||
    previousTurn.role !== "assistant" ||
    previousTurn.status !== "error"
  ) {
    return;
  }

  await repos.turns.updateStatus(previousTurn.id, {
    status: "complete",
    finishReason: previousTurn.finishReason,
    completedAt: previousTurn.completedAt,
    error: null,
  });
}

export async function projectReadModelEvent(
  repos: ReadModelProjectorRepositories,
  event: OrchestratorEvent,
): Promise<Turn | null> {
  switch (event.type) {
    case "turn.created": {
      const created = await repos.turns.create(turnToCreateInput(event.turn));
      await clearPreviousAssistantErrorIfUserTurn(repos, event.turn);
      return created;
    }
    case "turn.completed":
    case "turn.cancelled":
    case "turn.error":
      await repos.turns.updateStatus(event.turn.id, turnToLifecycleStatusUpdate(event.turn));
      return null;
    case "interrupt.created":
      await updateInterruptTurnStatus(repos, event.turnId, "waiting_interrupt");
      return null;
    case "interrupt.resolved":
    case "interrupt.expired":
      await updateInterruptTurnStatus(repos, event.turnId, "streaming");
      return null;
    case "model.response_received": {
      const response = responseToCreateInput(event.response);
      const result = await repos.modelResponses.create(response);
      if (!result.inserted) return null;
      const turn = await repos.turns.recomputeRollups(event.response.turnId);
      await repos.threads.recomputeCostFromModelResponses(turn.threadId);
      return null;
    }
    case "block.upserted":
      await repos.blocks.upsert(blockToUpsertInput(event.block));
      return null;
    case "block.updated":
      if (!(await repos.blocks.replaceExisting(blockToUpsertInput(event.block))))
        throw new Error(`Cannot replace missing block ${event.block.id}`);
      return null;
    case "block.pruned":
      await repos.blocks.updatePruned(event.blockId, true);
      return null;
    case "image.inclusion_decided":
      await projectImageInclusionDecision(repos, event);
      return null;
    default:
      return null;
  }
}

/** Shared repository write used by both journal projection and fork inheritance. */
export async function projectImageInclusionDecision(
  repos: Pick<ThreadRepositories, "imageInclusions">,
  event: Extract<OrchestratorEvent, { type: "image.inclusion_decided" }>,
): Promise<void> {
  await repos.imageInclusions.set(event);
}
