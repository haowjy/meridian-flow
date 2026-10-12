/**
 * spawn-output — the writer-facing helper card for a spawn or a foreground
 * `thread_message`. It's a custom block in the same family as ask_user's
 * card; the tool_use and tool_result stay protocol-only, and the model's text
 * is rendered by `model-spawn-result.ts`. Cost never reaches the card.
 */
import { GENERIC_SUBAGENT_NAME, GENERIC_SUBAGENT_SLUG } from "@meridian/contracts/agents";
import type { InvocationCardProps } from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedOutcome } from "@meridian/contracts/spawn";

export function invocationAgentName(slug: string, resolvedName?: string | null): string {
  return resolvedName ?? (slug === GENERIC_SUBAGENT_SLUG ? GENERIC_SUBAGENT_NAME : slug);
}

type InvocationCardInput = {
  agent?: string;
  agentName: string;
  name?: string;
  correlation: Pick<InvocationCardProps, "parentTurnId" | "toolCallId" | "deliveryMode">;
  childThreadId: ThreadId;
  execution: TurnId | null;
  startedAt: string;
  terminalAt: string | null;
  fromThreadId?: InvocationCardProps["fromThreadId"];
  fromThreadRef?: InvocationCardProps["fromThreadRef"];
  fromThreadTitle?: InvocationCardProps["fromThreadTitle"];
};

export function invocationCardProps(
  input: InvocationCardInput & {
    execution: TurnId;
    terminalAt: string;
    outcome: SavedOutcome;
  },
): Extract<InvocationCardProps, { outcome: SavedOutcome }>;
export function invocationCardProps(
  input: InvocationCardInput & { terminalAt: null; outcome?: undefined },
): Extract<InvocationCardProps, { terminalAt: null }>;
export function invocationCardProps(
  input: InvocationCardInput & { outcome?: SavedOutcome },
): InvocationCardProps;
export function invocationCardProps(input: InvocationCardInput & { outcome?: SavedOutcome }) {
  const slug = input.agent?.trim() || GENERIC_SUBAGENT_SLUG;
  const base = {
    agentSlug: slug,
    agentName: input.agentName,
    parentTurnId: input.correlation.parentTurnId,
    toolCallId: input.correlation.toolCallId,
    deliveryMode: input.correlation.deliveryMode,
    childThreadId: input.childThreadId,
    startedAt: input.startedAt,
    ...(input.name !== undefined ? { title: input.name } : {}),
    ...(input.fromThreadId !== undefined ? { fromThreadId: input.fromThreadId } : {}),
    ...(input.fromThreadRef !== undefined ? { fromThreadRef: input.fromThreadRef } : {}),
    ...(input.fromThreadTitle !== undefined ? { fromThreadTitle: input.fromThreadTitle } : {}),
  };
  if (input.outcome) {
    if (!input.execution) throw new Error("Terminal invocation card has no execution");
    if (!input.terminalAt) throw new Error("Terminal invocation card has no terminal time");
    return {
      ...base,
      execution: input.execution,
      outcome: input.outcome,
      terminalAt: input.terminalAt,
    };
  }
  if (input.terminalAt !== null) {
    throw new Error("Invocation card without an outcome cannot be terminal");
  }
  return { ...base, execution: input.execution, terminalAt: null };
}

export function unadmittedInvocationFailure(
  props: InvocationCardProps,
  reason: string,
): InvocationCardProps {
  const {
    childThreadId: _childThreadId,
    execution: _execution,
    outcome: _outcome,
    ...identity
  } = props;
  return {
    ...identity,
    terminalAt: new Date().toISOString(),
    reason,
  };
}

export function unadmittedInvocationFailureProps(input: {
  agent?: string;
  agentName?: string;
  name?: string;
  correlation: Pick<InvocationCardProps, "parentTurnId" | "toolCallId" | "deliveryMode">;
  reason: string;
}): InvocationCardProps {
  const slug = input.agent?.trim() || GENERIC_SUBAGENT_SLUG;
  return {
    agentSlug: slug,
    agentName: invocationAgentName(slug, input.agentName),
    parentTurnId: input.correlation.parentTurnId,
    toolCallId: input.correlation.toolCallId,
    deliveryMode: input.correlation.deliveryMode,
    startedAt: new Date().toISOString(),
    terminalAt: new Date().toISOString(),
    ...(input.name !== undefined ? { title: input.name } : {}),
    reason: input.reason,
  };
}
