/** Typed metadata codecs, constructors, and history classification for durable turns. */

import { SummaryRejectionReasonCodec } from "@meridian/contracts/runtime";
import type {
  JsonObject,
  JsonValue,
  PendingPlaceholderRole,
  Turn,
} from "@meridian/contracts/threads";
import { z } from "zod";

export const SystemUpdateMetadataCodec = z
  .object({
    kind: z.literal("system_update"),
    section: z.string().min(1),
  })
  .passthrough();

export const SavedSubagentReportMetadataCodec = SystemUpdateMetadataCodec.extend({
  section: z.literal("saved_subagent_report"),
});

export const ImageContextBreakCodec = z.object({
  blockId: z.string(),
  uri: z.string(),
  reason: z.enum(["asset_unavailable", "asset_unavailable_first_sight", "budget_eviction"]),
});

export const ImageInclusionMetadataCodec = SystemUpdateMetadataCodec.extend({
  section: z.literal("image_inclusion"),
  breaks: z.array(ImageContextBreakCodec),
});

export const InboxMessageMetadataCodec = z
  .object({
    kind: z.literal("inbox_message"),
    agentRequestKind: z.enum(["child_seed", "foreground_message"]).optional(),
  })
  .passthrough();

export const ChildCompletionMetadataTagCodec = z
  .object({ kind: z.literal("subagent_update") })
  .passthrough();

export const ChildCompletionMetadataCodec = z.object({
  kind: z.literal("subagent_update"),
  handle: z.string(),
  outcome: z.enum(["succeeded", "failed", "cancelled"]),
  execution: z.string().nullable(),
  childThreadId: z.string(),
  agentName: z.string(),
});

export const DerivationSeedMetadataCodec = z.object({
  kind: z.literal("derivation_seed"),
  derivation: z.enum(["fork", "handoff"]),
});

export const HandoffFailureReasonCodec = z.enum([
  ...SummaryRejectionReasonCodec.options,
  "handoff_brief_failed",
  "interrupted",
  "credits_exhausted",
]);
export const HandoffFailureOutcomeCodec = z.object({
  reason: HandoffFailureReasonCodec,
  phase: z.enum(["launch", "source_prepare", "summary", "settle", "recovery"]),
});
export type HandoffFailureOutcome = z.infer<typeof HandoffFailureOutcomeCodec>;

export const HandoffSeedMetadataCodec = DerivationSeedMetadataCodec.extend({
  derivation: z.literal("handoff"),
  sourceThreadId: z.string().min(1),
  sourceRef: z.string().min(1),
  sourceTitle: z.string().nullable(),
  cutoffTurnId: z.string().min(1),
  launches: z.number().int().nonnegative().default(0),
  summarizer: z
    .object({ path: z.enum(["branch", "rolling"]), segments: z.number().int().nonnegative() })
    .optional(),
  reason: HandoffFailureOutcomeCodec.shape.reason.optional(),
  phase: HandoffFailureOutcomeCodec.shape.phase.optional(),
}).passthrough();

const modelElisionsCodec = z.array(
  z.object({
    blockId: z.string(),
    treatment: z.enum(["stale_read", "stale_write"]),
    uris: z.array(z.string()),
    content: z.json(),
  }),
);

export const CompactionUndoFailureReasonCodec = z.enum([
  "would_recompact",
  "not_active",
  "already_undone",
  "undo_failed",
]);
export type CompactionUndoFailureReason = z.infer<typeof CompactionUndoFailureReasonCodec>;

export const CompactionUndoMetadataCodec = z
  .object({
    kind: z.literal("compaction_undo"),
    revertsCompactionTurnId: z.string().min(1),
    reason: CompactionUndoFailureReasonCodec.optional(),
    compactionTriggerTokens: z.number().int().nonnegative().optional(),
    controlMessageId: z.string().optional(),
    elisions: modelElisionsCodec.optional(),
  })
  .passthrough();

const compactedThroughCodec = z.object({
  turnId: z.string().min(1),
  blockSequence: z.number().int().nonnegative().optional(),
});

export const CompactionFailureReasonCodec = z.enum([
  "nothing_to_compact",
  "context_too_large",
  "compaction_failed",
  "context_window_exceeded",
  ...SummaryRejectionReasonCodec.options,
  "interrupted",
]);
export const CompactionFailurePhaseCodec = z.enum([
  "summary",
  "initial_prepare",
  "delivery",
  "recovery",
]);
export const CompactionFailureOutcomeCodec = z.object({
  reason: CompactionFailureReasonCodec,
  phase: CompactionFailurePhaseCodec,
  estimatedTokens: z.number().int().nonnegative().optional(),
  fitLimitTokens: z.number().int().nonnegative().optional(),
});

export type CompactionFailureOutcome = z.infer<typeof CompactionFailureOutcomeCodec>;

const compactionFailureMetadataFields = {
  reason: CompactionFailureReasonCodec.optional(),
  phase: CompactionFailurePhaseCodec.optional(),
  estimatedTokens: z.number().int().nonnegative().optional(),
  fitLimitTokens: z.number().int().nonnegative().optional(),
};

const compactionMetadataFields = {
  elisions: modelElisionsCodec.optional(),
  trigger: z.enum(["auto", "manual"]).optional(),
  controlMessageId: z.string().min(1).optional(),
};

export const CompactionPlanMetadataCodec = z
  .object({
    ...compactionMetadataFields,
    compactedThrough: compactedThroughCodec,
    pinnedRequestTurnIds: z.array(z.string().min(1)).min(1),
    ...compactionFailureMetadataFields,
  })
  .passthrough()
  .superRefine((metadata, context) => {
    if ((metadata.reason === undefined) !== (metadata.phase === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Compaction failure metadata must include both reason and phase",
      });
    }
  });

const CompactionFailureMetadataCodec = z
  .object({
    ...compactionMetadataFields,
    compactedThrough: compactedThroughCodec.optional(),
    pinnedRequestTurnIds: z.array(z.string().min(1)).min(1).optional(),
    reason: CompactionFailureReasonCodec,
    phase: CompactionFailurePhaseCodec,
    estimatedTokens: z.number().int().nonnegative().optional(),
    fitLimitTokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const CompactionMetadataCodec = z.union([
  CompactionPlanMetadataCodec,
  CompactionFailureMetadataCodec,
]);

export const PromptEpochMetadataCodec = z.union([
  z
    .object({
      kind: z.literal("prompt_epoch_boundary"),
      cause: z.enum(["compaction", "compaction_undo"]),
    })
    .passthrough(),
  z
    .object({ promptEpoch: z.object({ cause: z.enum(["compaction", "compaction_undo"]) }) })
    .passthrough(),
]);

export const SteerMetadataCodec = z.object({ delivery: z.literal("steer") }).passthrough();

export type ImageContextBreak = z.infer<typeof ImageContextBreakCodec>;
export type ImageInclusionMetadata = z.infer<typeof ImageInclusionMetadataCodec>;
export type CompactionMetadata = z.infer<typeof CompactionMetadataCodec>;
export type CompactionPlanMetadata = z.infer<typeof CompactionPlanMetadataCodec>;
export type CompactionFailureReason = z.infer<typeof CompactionFailureReasonCodec>;
export type CompactionFailurePhase = z.infer<typeof CompactionFailurePhaseCodec>;
export type AgentRequestOrigin = "spawn" | "message";
export type AgentRequestSource = "inbox_message" | "child_seed" | "foreground_message";

export type HistoryItemClass =
  | { kind: "writer_request"; delivery?: "steer" }
  | { kind: "agent_request"; source: AgentRequestSource }
  | { kind: "child_completion" }
  | { kind: "work_update" }
  | { kind: "notice" }
  | { kind: "skill_body" }
  | { kind: "image_update" }
  | { kind: "fork_or_handoff_seed"; derivation: "fork" | "handoff" }
  | { kind: "compaction"; metadata?: CompactionMetadata }
  | { kind: "undo_marker"; compactionTurnId: string }
  | { kind: "system_update" }
  | { kind: "assistant_response" }
  | { kind: "other" };

export function writerSendMetadata(
  metadata: JsonValue | null | undefined,
  delivery: "send" | "steer" = "send",
): JsonValue | null {
  if (delivery === "steer") return steerMetadata(metadata);
  return metadata ?? null;
}

/** Preserve the writer's own metadata while adding the durable mid-run steer marker. */
export function steerMetadata(metadata: JsonValue | null | undefined): JsonObject {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return { ...(metadata as JsonObject), delivery: "steer" };
  }
  return metadata === null || metadata === undefined
    ? { delivery: "steer" }
    : { delivery: "steer", originalMetadata: metadata };
}

export function inboxMessageMetadata(extra: JsonObject = {}): JsonObject {
  return { ...extra, kind: "inbox_message" };
}

export function agentRequestMetadata(origin: AgentRequestOrigin): JsonObject {
  return origin === "spawn" ? childSeedMetadata() : foregroundMessageMetadata();
}

export function childSeedMetadata(): JsonObject {
  return { kind: "inbox_message", agentRequestKind: "child_seed" };
}

export function foregroundMessageMetadata(): JsonObject {
  return { kind: "inbox_message", agentRequestKind: "foreground_message" };
}

export function childCompletionMetadata(input: {
  handle: string;
  outcome: string;
  execution: string | null;
  childThreadId: string;
  agentName: string;
}): JsonObject {
  return { kind: "subagent_update", ...input };
}

export function workUpdateMetadata(): JsonObject {
  return systemUpdateMetadata("work_context");
}

export function noticesMetadata(): JsonObject {
  return systemUpdateMetadata("notices");
}

export function skillBodyMetadata(): JsonObject {
  return systemUpdateMetadata("skill_body");
}

export function compactionSummaryMetadata(): JsonObject {
  return systemUpdateMetadata("compaction_summary");
}

export function savedSubagentReportMetadata(): JsonObject {
  return systemUpdateMetadata("saved_subagent_report");
}

function systemUpdateMetadata(section: string): JsonObject {
  return { kind: "system_update", section };
}

export function derivationSeedMetadata(derivation: "fork" | "handoff"): JsonObject {
  return { kind: "derivation_seed", derivation };
}

export function handoffSeedMetadata(input: {
  sourceThreadId: string;
  sourceRef: string;
  sourceTitle: string | null;
  cutoffTurnId: string;
  launches?: number;
}): JsonObject {
  return { ...derivationSeedMetadata("handoff"), ...input, launches: input.launches ?? 0 };
}

export function compactionUndoMetadata(
  revertsCompactionTurnId: string,
  controlMessageId?: string,
  reason?: CompactionUndoFailureReason,
  compactionTriggerTokens?: number,
): JsonObject {
  return {
    kind: "compaction_undo",
    revertsCompactionTurnId,
    ...(reason ? { reason } : {}),
    ...(compactionTriggerTokens === undefined ? {} : { compactionTriggerTokens }),
    ...(controlMessageId ? { controlMessageId } : {}),
  };
}

export function compactionTurnMetadata(metadata: CompactionPlanMetadata): JsonObject {
  return {
    compactedThrough: { ...metadata.compactedThrough },
    pinnedRequestTurnIds: metadata.pinnedRequestTurnIds,
    ...(metadata.trigger ? { trigger: metadata.trigger } : {}),
  };
}

/** Replace failure fields without disturbing the placeholder's control metadata. */
export function compactionFailureMetadata(
  metadata: JsonValue | null | undefined,
  failure: CompactionFailureOutcome,
): JsonObject {
  const previous =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as JsonObject)
      : {};
  const preserved = { ...previous };
  delete preserved.reason;
  delete preserved.phase;
  delete preserved.estimatedTokens;
  delete preserved.fitLimitTokens;
  return {
    ...preserved,
    reason: failure.reason,
    phase: failure.phase,
    ...(failure.estimatedTokens === undefined ? {} : { estimatedTokens: failure.estimatedTokens }),
    ...(failure.fitLimitTokens === undefined ? {} : { fitLimitTokens: failure.fitLimitTokens }),
  };
}

/** The writer-facing failure copy for an interrupted pending placeholder. */
export function interruptedPlaceholderError(
  turn: Pick<Turn, "metadata"> & { role: PendingPlaceholderRole },
): string {
  switch (turn.role) {
    case "system":
      return "This handoff brief was interrupted.";
    case "compaction": {
      return (turn.metadata as JsonObject | null)?.trigger === "manual"
        ? "This manual compaction was interrupted."
        : "This compaction was interrupted.";
    }
    default: {
      const exhaustiveRole: never = turn.role;
      return exhaustiveRole;
    }
  }
}

export function encodeImageInclusionMetadata(breaks: readonly ImageContextBreak[]): JsonObject {
  return {
    kind: "system_update",
    section: "image_inclusion",
    breaks: breaks.map(({ blockId, uri, reason }) => ({ blockId, uri, reason })),
  };
}

export function decodeImageInclusionMetadata(value: unknown): ImageInclusionMetadata | null {
  const parsed = ImageInclusionMetadataCodec.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function promptEpochMetadata(
  metadata: JsonValue | null | undefined,
  cause: "compaction" | "compaction_undo",
): JsonObject {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return { ...(metadata as JsonObject), promptEpoch: { cause } };
  }
  return { kind: "prompt_epoch_boundary", cause, previousMetadata: metadata ?? null };
}

export function isSystemUpdateMetadata(metadata: Turn["metadata"]): boolean {
  return SystemUpdateMetadataCodec.safeParse(metadata).success;
}

export function isPromptEpochMetadata(metadata: Turn["metadata"]): boolean {
  return PromptEpochMetadataCodec.safeParse(metadata).success;
}

/** Classifies stored turns once so compaction and history inspection share the same rules. */
export function classifyHistoryItem(
  turn: Pick<Turn, "role" | "origin" | "metadata">,
): HistoryItemClass {
  if (turn.role === "compaction") {
    const compaction = CompactionMetadataCodec.safeParse(turn.metadata);
    return compaction.success
      ? { kind: "compaction", metadata: compaction.data }
      : { kind: "compaction" };
  }

  const undo = CompactionUndoMetadataCodec.safeParse(turn.metadata);
  if (undo.success) {
    return { kind: "undo_marker", compactionTurnId: undo.data.revertsCompactionTurnId };
  }

  const derivationSeed = DerivationSeedMetadataCodec.safeParse(turn.metadata);
  if (derivationSeed.success) {
    return { kind: "fork_or_handoff_seed", derivation: derivationSeed.data.derivation };
  }

  if (ImageInclusionMetadataCodec.safeParse(turn.metadata).success) {
    return { kind: "image_update" };
  }

  if (SavedSubagentReportMetadataCodec.safeParse(turn.metadata).success) {
    return { kind: "system_update" };
  }

  const systemUpdate = SystemUpdateMetadataCodec.safeParse(turn.metadata);
  if (systemUpdate.success) {
    if (systemUpdate.data.section === "work_context") return { kind: "work_update" };
    if (systemUpdate.data.section === "notices") return { kind: "notice" };
    if (systemUpdate.data.section === "skill_body") return { kind: "skill_body" };
    return { kind: "system_update" };
  }

  if (turn.role === "system" && ChildCompletionMetadataCodec.safeParse(turn.metadata).success) {
    return { kind: "child_completion" };
  }

  if (turn.role === "user") {
    if (turn.origin === "writer") {
      return SteerMetadataCodec.safeParse(turn.metadata).success
        ? { kind: "writer_request", delivery: "steer" }
        : { kind: "writer_request" };
    }
    const inbox = InboxMessageMetadataCodec.safeParse(turn.metadata);
    if (turn.origin === "system" && inbox.success) {
      return { kind: "agent_request", source: inbox.data.agentRequestKind ?? "inbox_message" };
    }
  }

  if (turn.role === "assistant" && turn.origin === "assistant") {
    return { kind: "assistant_response" };
  }
  return { kind: "other" };
}

/** Effective transcript, already bounded by a fork cutoff, owns its reverted set. */
export function revertedCompactionIds(turns: readonly Turn[]): Set<string> {
  return new Set(
    turns.flatMap((turn) => {
      if (turn.status !== "complete") return [];
      const undo = CompactionUndoMetadataCodec.safeParse(turn.metadata);
      return undo.success ? [undo.data.revertsCompactionTurnId] : [];
    }),
  );
}
export function activeCompaction(turns: readonly Turn[]): Turn | null {
  const reverted = revertedCompactionIds(turns);
  return (
    [...turns]
      .sort((a, b) => b.position - a.position)
      .find(
        (turn) =>
          turn.role === "compaction" && turn.status === "complete" && !reverted.has(turn.id),
      ) ?? null
  );
}
