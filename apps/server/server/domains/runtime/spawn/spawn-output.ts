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
import { GENERIC_SUBAGENT_SLUG } from "@meridian/contracts/agents";
import type { HelperResultProps, InvocationCardProps } from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedOutcome } from "@meridian/contracts/spawn";
import type { JsonValue } from "@meridian/contracts/threads";

const QUEUED_NO_REPLY_NOTE =
  "Message queued. No reply is pushed back; the target's response is readable in its transcript.";

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

export function spawnHelperCardProps(input: {
  agent?: string;
  description?: string;
  parentTurnId: string;
  childThreadId?: string;
  output?: JsonValue;
}): HelperResultProps {
  const slug = input.agent?.trim() || GENERIC_SUBAGENT_SLUG;
  const base: HelperResultProps = {
    agentSlug: slug,
    agentName: helperAgentName(slug),
    status: "running",
    parentTurnId: input.parentTurnId,
    ...(input.description !== undefined ? { title: input.description } : {}),
    ...(input.childThreadId !== undefined ? { childThreadId: input.childThreadId } : {}),
  };
  const output = input.output;
  if (!isRecord(output)) return base;
  if (output.status === "completed") {
    return {
      ...base,
      status: "completed",
    };
  }
  if (output.status === "error") {
    return {
      ...base,
      status: "failed",
    };
  }
  return base;
}

function helperAgentName(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

export function invocationCardProps(input: {
  agent?: string;
  description?: string;
  correlation: Pick<InvocationCardProps, "parentTurnId" | "toolCallId" | "deliveryMode">;
  childThreadId: ThreadId;
  execution: TurnId | null;
  outcome?: SavedOutcome;
}): InvocationCardProps {
  const slug = input.agent?.trim() || GENERIC_SUBAGENT_SLUG;
  const base = {
    agentSlug: slug,
    agentName: helperAgentName(slug),
    parentTurnId: input.correlation.parentTurnId,
    toolCallId: input.correlation.toolCallId,
    deliveryMode: input.correlation.deliveryMode,
    childThreadId: input.childThreadId,
    ...(input.description !== undefined ? { title: input.description } : {}),
  };
  if (input.outcome) {
    if (!input.execution) throw new Error("Terminal invocation card has no execution");
    return {
      ...base,
      status: input.outcome === "succeeded" ? "completed" : "failed",
      execution: input.execution,
      outcome: input.outcome,
    };
  }
  return { ...base, status: "running", execution: input.execution };
}

export function unadmittedInvocationFailure(props: InvocationCardProps): InvocationCardProps {
  const { status: _status, execution: _execution, outcome: _outcome, ...identity } = props;
  return { ...identity, status: "failed", execution: null };
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
