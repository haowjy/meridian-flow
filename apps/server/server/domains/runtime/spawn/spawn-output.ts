/**
 * spawn-output — transcript-facing spawn payloads.
 *
 * Cost stays on the internal report / tree budget, never on the tool output.
 * The model copy keeps the short `handle` but drops the internal UUID
 * (`threadId`); UI navigation reads the UUID off the helper card, not here.
 * The writer-facing surface is a helper-result custom block, same family as
 * ask_user's custom card: the spawn tool_use/tool_result stay protocol-only.
 *
 * `queuedNoReply` marks a `thread_message` background result: it pushes no
 * reply back to the sender, unlike a background spawn child that reports on
 * completion. The result says where the response lives instead of implying a
 * reply is coming.
 */
import { GENERIC_SUBAGENT_NAME, GENERIC_SUBAGENT_SLUG } from "@meridian/contracts/agents";
import type { InvocationCardProps } from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedOutcome } from "@meridian/contracts/spawn";
import type { JsonValue } from "@meridian/contracts/threads";

const QUEUED_NO_REPLY_NOTE =
  "Message queued. No reply is pushed back; the target's response is readable in its transcript.";

export function invocationAgentName(slug: string, resolvedName?: string | null): string {
  return resolvedName ?? (slug === GENERIC_SUBAGENT_SLUG ? GENERIC_SUBAGENT_NAME : slug);
}

export function spawnOutputForTranscript(
  output: JsonValue,
  options: { queuedNoReply?: boolean } = {},
): JsonValue {
  if (!isRecord(output)) return output;
  if (output.status === "completed" || output.status === "error") {
    const report = output.report;
    const { execution: _execution, ...modelOutput } = output;
    if (!isRecord(report)) return modelOutput;
    const reportWithoutCost = { ...report };
    delete reportWithoutCost.costMillicredits;
    delete reportWithoutCost.threadId;
    return { ...modelOutput, report: reportWithoutCost };
  }
  if (output.status === "background") {
    const { threadId: _threadId, execution: _execution, ...rest } = output;
    return options.queuedNoReply ? { ...rest, note: QUEUED_NO_REPLY_NOTE } : rest;
  }
  return output;
}

type InvocationCardInput = {
  agent?: string;
  agentName: string;
  description?: string;
  correlation: Pick<InvocationCardProps, "parentTurnId" | "toolCallId" | "deliveryMode">;
  childThreadId: ThreadId;
  execution: TurnId | null;
  startedAt: string;
  terminalAt: string | null;
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
    ...(input.description !== undefined ? { title: input.description } : {}),
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
  description?: string;
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
    ...(input.description !== undefined ? { title: input.description } : {}),
    reason: input.reason,
  };
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
