/** Prepare restored history without writes; complete U with its reused bake in the boundary commit. */

import type { PromptBakeId, ThreadId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import {
  activeCompaction,
  bakeIdAt,
  CompactionMetadataCodec,
  compactionUndoMetadata,
  ImageInclusionMetadataCodec,
  promptEpochMetadata,
  revertedCompactionIds,
} from "../../threads/index.js";
import { nextTurnPosition } from "../../threads/order-turns.js";
import { beginPromptEpoch } from "./begin-prompt-epoch.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { collectRecordedDocuments, planModelElisions } from "./compaction/elide.js";
import { estimateRequestTokens, projectActiveHistory } from "./compaction/index.js";
import { queryCompactionRevisions } from "./compaction-revisions.js";
import type { ControlMessage } from "./control-barrier.js";
import { createLocalTurn } from "./local-turn.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { persistAndAppendEvents } from "./persistence.js";
import type { AssembledNextTurnContext } from "./turn-context-assembly.js";

export const COMPACTION_UNDO_TEXT =
  "The writer undid the compaction here. The earlier conversation above is restored.";
export type PreparedUndo = {
  controlId: string;
  turn: Turn;
  block?: ReturnType<typeof contentForBlockInput>;
};

/** Q2/R-C6-2: keep the refusal in one place pending the user's ruling. */
function wouldRecompact(tokens: number, trigger: number | null): boolean {
  return trigger !== null && tokens >= trigger;
}

export async function prepareCompactionUndo(input: {
  deps: OrchestratorDeps;
  thread: import("@meridian/contracts/threads").Thread;
  turns: Turn[];
  blocks: Block[];
  control: ControlMessage;
  signal?: AbortSignal;
  forceFailure?: boolean;
  assertNoResponseScope?: () => void;
  assemble(turns: Turn[], blocks: Block[]): Promise<AssembledNextTurnContext>;
}): Promise<PreparedUndo> {
  const { deps, thread, turns, blocks, control } = input;
  if (control.body.kind !== "compaction_undo") throw new Error("Expected undo control");
  const targetId = control.body.compactionTurnId;
  const leaf = turns.at(-1);
  const turn = createLocalTurn({
    threadId: thread.id,
    position: nextTurnPosition(leaf ?? null),
    prevTurnId: leaf?.id ?? null,
    role: "system",
    origin: "system",
    status: "complete",
    metadata: compactionUndoMetadata(targetId, control.id),
  });
  const refused = (
    reason: "already_undone" | "not_active" | "would_recompact" | "undo_failed",
  ): PreparedUndo => ({
    controlId: control.id,
    turn: {
      ...turn,
      status: "error",
      promptBakeId: null,
      metadata: compactionUndoMetadata(targetId, control.id),
      error: reason,
      completedAt: new Date().toISOString(),
    },
  });
  if (input.forceFailure) return refused("undo_failed");
  input.assertNoResponseScope?.();
  const target = turns.find((t) => t.id === targetId);
  if (revertedCompactionIds(turns).has(targetId)) return refused("already_undone");
  if (!target || target.threadId !== thread.id || activeCompaction(turns)?.id !== targetId)
    return refused("not_active");
  try {
    const before = turns.filter((t) => t.position < target.position);
    const predecessor = before.at(-1);
    const bakeId = predecessor
      ? bakeIdAt(before, predecessor.id, thread.initialPromptBakeId ?? null)
      : thread.initialPromptBakeId;
    if (!bakeId || !(await deps.repos.promptBakes.findById(bakeId)))
      throw new Error("Missing pre-compaction bake");
    turn.promptBakeId = bakeId;
    turn.metadata = promptEpochMetadata(turn.metadata, "compaction_undo");
    const restored = [...turns, turn];
    // Ignore older U owners while planning: the new pass must cover their raw source too.
    const withoutUndoElisions = restored.map((t) =>
      (t.metadata as { kind?: string })?.kind === "compaction_undo"
        ? {
            ...t,
            metadata: {
              ...(t.metadata as import("@meridian/contracts/threads").JsonObject),
              elisions: [],
            },
          }
        : t,
    );
    const projection = projectActiveHistory(withoutUndoElisions, blocks, thread.ref);
    const active = activeCompaction(restored);
    const excluded = new Set(
      active ? CompactionMetadataCodec.parse(active.metadata).elisions?.map((e) => e.blockId) : [],
    );
    const raw = new Map(blocks.map((b) => [b.id, b]));
    const slices = projection.turns.map((t) => ({
      turn: t,
      blocks: projection.blocks
        .filter((b) => b.turnId === t.id && raw.has(b.id) && !excluded.has(b.id))
        .map((b) => raw.get(b.id)!),
    }));
    const policies = (name: string) => deps.toolRegistry.getRegistration(name)?.documentText;
    const recorded = collectRecordedDocuments(slices, policies);
    const current = await queryCompactionRevisions({
      threadId: thread.id,
      recorded,
      revisions: deps.documentRevisions,
      assertNoResponseScope: () => {
        // Delivery invokes this only between model responses, never within staged tool writes.
      },
    });
    const elisions = planModelElisions({ retainedSuffix: slices, recorded, current, policies });
    turn.metadata = {
      ...(turn.metadata as import("@meridian/contracts/threads").JsonObject),
      elisions,
    };
    const block = contentForBlockInput({
      turnId: turn.id,
      blockType: "text",
      sequence: 0,
      textContent: COMPACTION_UNDO_TEXT,
      status: "complete",
    });
    const assembled = await input.assemble(
      [...turns, turn],
      [...blocks, localBlockFromEvent(block)],
    );
    const candidate = [...before]
      .reverse()
      .find((t) => t.role === "assistant" && t.responseCount > 0);
    const responses = candidate ? await deps.repos.modelResponses.listByTurn(candidate.id) : [];
    const response = responses.sort((a, b) => b.sequence - a.sequence)[0];
    const afterCandidate = candidate
      ? [...turns, ...assembled.imageContextUpdates.turns].filter(
          (t) => t.position > candidate.position,
        )
      : [];
    const imageEviction = afterCandidate.some((t) => {
      const image = ImageInclusionMetadataCodec.safeParse(t.metadata);
      return (
        image.success && image.data.breaks.some((b) => b.reason !== "asset_unavailable_first_sight")
      );
    });
    const prefixElision =
      candidate &&
      elisions.some((e) => {
        const owner = turns.find((t) => t.id === raw.get(e.blockId)?.turnId);
        return owner && owner.position <= candidate.position;
      });
    const baseline =
      candidate &&
      response &&
      response.inputTokens > 0 &&
      response.requestMessageCount !== null &&
      response.model === assembled.resolvedModel?.id &&
      !imageEviction &&
      !prefixElision &&
      !(active && active.position > candidate.position) &&
      bakeIdAt(before, candidate.id, thread.initialPromptBakeId ?? null) === bakeId
        ? { inputTokens: response.inputTokens, messageCount: response.requestMessageCount }
        : null;
    const tokenizer = assembled.resolvedModel?.tokenizer;
    if (!tokenizer) throw new Error("Undo measurement requires the current model tokenizer");
    const tokens = estimateRequestTokens({
      request: assembled.generateRequest,
      baseline,
      tokenizer,
    });
    if (wouldRecompact(tokens, assembled.compactionTriggerTokens))
      return refused("would_recompact");
    return { controlId: control.id, turn, block };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return refused("undo_failed");
  }
}

/** Persist the prepared sequence inside its delivery transaction. U is announced only complete. */
export async function persistPreparedControlEvents(
  deps: Parameters<typeof beginPromptEpoch>[0],
  threadId: ThreadId,
  events: OrchestratorEvent[],
  undos: readonly PreparedUndo[],
): Promise<OrchestratorEvent[]> {
  if (undos.length === 0) return events;
  const complete = new Map(
    undos.filter((u) => u.turn.status === "complete").map((u) => [u.turn.id, u]),
  );
  let prefix: OrchestratorEvent[] = [];
  for (const event of events) {
    const undo = event.type === "turn.created" ? complete.get(event.turn.id) : undefined;
    if (!undo) {
      prefix.push(event);
      continue;
    }
    await persistAndAppendEvents(deps, threadId, async () => ({
      result: undefined,
      events: prefix,
    }));
    prefix = [];
    await deps.repos.turns.create({ ...undo.turn, status: "pending", promptBakeId: null });
    await beginPromptEpoch(deps, {
      threadId,
      cause: "compaction_undo",
      boundaryTurnId: undo.turn.id,
      bake: { reuse: undo.turn.promptBakeId as PromptBakeId },
      completion: { blocks: [undo.block!], metadata: undo.turn.metadata, announceBoundary: true },
    });
  }
  return prefix;
}

/** Advisory only: execution measures the fully restored request with today's trigger. */
export function createCompactionUndoReader(
  deps: Pick<OrchestratorDeps, "agentRevisions" | "toolRegistry" | "gateway">,
) {
  return async (
    thread: import("@meridian/contracts/threads").Thread,
    turns: Turn[],
  ): Promise<import("@meridian/contracts/threads").CompactionUndoAvailability> => {
    const compaction = activeCompaction(turns);
    if (!compaction || compaction.threadId !== thread.id) return null;
    const { resolveAgentThreadTurnContext } = await import("../tools/agent-thread-context.js");
    const { resolveCompactionTrigger, CompactionBlockContentCodec } = await import(
      "./compaction/index.js"
    );
    const context = await resolveAgentThreadTurnContext({ ...deps, thread, baseTools: undefined });
    const modelId = context.gatewayParams.model ?? deps.gateway.getDefaultModel();
    const model = deps.gateway.listModels?.().find((model) => model.id === modelId);
    if (!model) return null;
    const trigger = resolveCompactionTrigger({
      ...context.compaction,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      inputTierTokens: model.inputTierTokens,
    });
    const summary = compaction.blocks.find((block) => block.blockType === "custom");
    const props = CompactionBlockContentCodec.parse(summary?.content).props;
    return {
      turnId: compaction.id,
      availability: wouldRecompact(props.tokensBefore, trigger.thresholdTokens)
        ? "would_recompact"
        : "likely",
    };
  };
}
