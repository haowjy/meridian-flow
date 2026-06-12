/**
 * Purpose: JSON-natural debug record for one orchestrator model request — agent,
 * skills, tools, and verbatim system prompts as sent to the gateway.
 * Key decisions: dev-only capture; never persisted to journal or thread snapshots.
 */
import type { JsonValue } from "./index.js";

/** One model request as assembled by the orchestrator, captured just before gateway.stream(). */
export type ModelRequestDebugRecord = {
  threadId: string;
  /** Assistant turn the request belongs to. */
  turnId: string;
  /** 0-based tool-loop iteration within the turn. */
  iteration: number;
  /** ISO 8601 */
  requestedAt: string;
  /** thread.currentAgent at request time */
  agentSlug: string | null;
  model: string | null;
  provider: string | null;
  /** Effort config as sent to the gateway. */
  reasoning: JsonValue | null;
  /** Verbatim system-role message texts, in order. */
  systemMessages: string[];
  skills: { slug: string; layer: string }[];
  tools: { name: string; source: string; capability: string | null }[];
  /** Non-system messages in the request. */
  messageCount: number;
};

type AssertJsonValue<T extends JsonValue> = T;
type _ModelRequestDebugRecordIsJsonValue = AssertJsonValue<ModelRequestDebugRecord>;
