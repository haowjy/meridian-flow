/** Shared typed metadata codecs, constructors, and history classification for durable turns. */

import type { JsonObject, Turn } from "@meridian/contracts/threads";
import { z } from "zod";

export const SystemUpdateMetadataCodec = z.object({
  kind: z.literal("system_update"),
  section: z.string().min(1),
});

export const InboxMessageMetadataCodec = z
  .object({
    kind: z.literal("inbox_message"),
    agentRequestKind: z.enum(["child_seed", "foreground_message"]).optional(),
  })
  .passthrough();

export const ChildCompletionMetadataCodec = z.object({
  kind: z.literal("subagent_update"),
  handle: z.string(),
  outcome: z.string(),
  execution: z.string(),
});

export const DerivationSeedMetadataCodec = z.object({
  kind: z.literal("derivation_seed"),
  derivation: z.enum(["fork", "handoff"]),
});

export const CompactionUndoMetadataCodec = z.object({
  kind: z.literal("compaction_undo"),
  revertsCompactionTurnId: z.string().min(1),
});

export const PromptEpochMetadataCodec = z.union([
  z.object({
    kind: z.literal("prompt_epoch_boundary"),
    cause: z.enum(["compaction", "compaction_undo"]),
  }),
  z.object({
    promptEpoch: z.object({ cause: z.enum(["compaction", "compaction_undo"]) }),
  }),
]);

export type AgentRequestOrigin = "spawn" | "message";
export type AgentRequestSource = "inbox_message" | "child_seed" | "foreground_message";

export type HistoryItemClass =
  | { kind: "writer_request" }
  | { kind: "agent_request"; source: AgentRequestSource }
  | { kind: "child_completion" }
  | { kind: "work_update" }
  | { kind: "notice" }
  | { kind: "skill_body" }
  | { kind: "image_update" }
  | { kind: "fork_or_handoff_seed"; derivation: "fork" | "handoff" }
  | { kind: "compaction" }
  | { kind: "undo_marker"; compactionTurnId: string }
  | { kind: "system_update" }
  | { kind: "assistant_response" }
  | { kind: "other" };

const metadataSectionCodec = z.object({ section: z.string().min(1) });

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
  execution: string;
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

function systemUpdateMetadata(section: string): JsonObject {
  return { kind: "system_update", section };
}

export function derivationSeedMetadata(derivation: "fork" | "handoff"): JsonObject {
  return { kind: "derivation_seed", derivation };
}

export function compactionUndoMetadata(revertsCompactionTurnId: string): JsonObject {
  return { kind: "compaction_undo", revertsCompactionTurnId };
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
  if (turn.role === "compaction") return { kind: "compaction" };

  const undo = CompactionUndoMetadataCodec.safeParse(turn.metadata);
  if (undo.success) {
    return { kind: "undo_marker", compactionTurnId: undo.data.revertsCompactionTurnId };
  }

  const derivationSeed = DerivationSeedMetadataCodec.safeParse(turn.metadata);
  if (derivationSeed.success) {
    return { kind: "fork_or_handoff_seed", derivation: derivationSeed.data.derivation };
  }

  // Image-update metadata is owned by the image domain; its section is the classifier contract.
  const section = metadataSectionCodec.safeParse(turn.metadata);
  if (section.success && section.data.section === "image_inclusion") {
    return { kind: "image_update" };
  }

  const systemUpdate = SystemUpdateMetadataCodec.safeParse(turn.metadata);
  if (systemUpdate.success) {
    if (systemUpdate.data.section === "work_context") return { kind: "work_update" };
    if (systemUpdate.data.section === "notices") return { kind: "notice" };
    if (systemUpdate.data.section === "skill_body") return { kind: "skill_body" };
    return { kind: "system_update" };
  }

  const childCompletion = ChildCompletionMetadataCodec.safeParse(turn.metadata);
  if (turn.role === "system" && childCompletion.success) return { kind: "child_completion" };

  if (turn.role === "user") {
    if (turn.origin === "writer") return { kind: "writer_request" };
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
