/**
 * Shared custom component blocks.
 */

import { z } from "zod";
import type { ThreadId, TurnId } from "../runtime/index.js";
import type { ExecutionReportDelivery, SavedOutcome } from "../spawn/index.js";
import type { JsonObject } from "../threads/index.js";

/** Registry key for a renderer/tool-owned custom component. */
export type ComponentKind = string;

/**
 * Canonical content persisted in `Block.content` for `blockType: "custom"` component blocks.
 * Generic props keep the component registry as the extension seam: new components add a kind and renderer without changing the block envelope.
 */
export type ComponentBlockContent = {
  kind: ComponentKind;
  props: JsonObject;
};

/** Runtime-created pointer in a child's first user turn; text is frozen at spawn. */
export type ThreadReferenceProps = {
  threadId: string;
  ref: string;
  title: string | null;
  agentName: string | null;
  lastActivityAt: string;
  text: string;
};

/** Writer-facing handoff card data, frozen when its seed is reserved. */
export type HandoffBriefProps = {
  state: "available" | "unavailable";
  brief: string | null;
  sourceThreadId: string;
  sourceRef: string;
  sourceTitle: string | null;
  cutoffTurnId: string;
  model: string | null;
  modelText: string;
};

/** Identity and timing shared by every retained child invocation card. */
type InvocationCardBase = {
  agentSlug: string;
  agentName: string;
  parentTurnId: TurnId;
  toolCallId: string;
  deliveryMode: Extract<ExecutionReportDelivery, "direct" | "background_notification">;
  startedAt: string;
  title?: string;
  fromThreadId?: ThreadId;
  fromThreadRef?: string;
  fromThreadTitle?: string | null;
};

/** Exact parent invocation identity retained on a child run's historical card. */
export type InvocationCardProps = InvocationCardBase &
  (
    | {
        childThreadId: ThreadId;
        execution: TurnId | null;
        terminalAt: null;
        outcome?: never;
        reason?: never;
      }
    | {
        childThreadId: ThreadId;
        execution: TurnId;
        terminalAt: string;
        outcome: SavedOutcome;
        reason?: never;
      }
    | {
        childThreadId?: never;
        execution?: never;
        terminalAt: string;
        outcome?: never;
        reason: string;
      }
  );

const invocationCardBaseSchema = z.strictObject({
  agentSlug: z.string(),
  agentName: z.string(),
  parentTurnId: z.string(),
  toolCallId: z.string(),
  deliveryMode: z.enum(["direct", "background_notification"]),
  startedAt: z.string(),
  title: z.string().optional(),
  fromThreadId: z.string().optional(),
  fromThreadRef: z.string().optional(),
  fromThreadTitle: z.string().nullable().optional(),
});

export const invocationCardPropsSchema = z.union([
  invocationCardBaseSchema.extend({
    childThreadId: z.string(),
    execution: z.string().nullable(),
    terminalAt: z.null(),
  }),
  invocationCardBaseSchema.extend({
    childThreadId: z.string(),
    execution: z.string(),
    terminalAt: z.string(),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
  }),
  invocationCardBaseSchema.extend({
    terminalAt: z.string(),
    reason: z.string().min(1),
  }),
]);

/** Parse the single persisted invocation-card shape; malformed cards are ignored. */
export function parseInvocationCard(content: unknown): InvocationCardProps | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const candidate = content as Record<string, unknown>;
  if (candidate.kind !== "helper-result") return null;
  const parsed = invocationCardPropsSchema.safeParse(candidate.props);
  return parsed.success ? (parsed.data as InvocationCardProps) : null;
}

export function buildInvocationCardContent(input: InvocationCardProps): ComponentBlockContent {
  return { kind: "helper-result", props: input as unknown as JsonObject };
}
