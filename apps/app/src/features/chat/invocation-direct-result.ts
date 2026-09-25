/** Turn-scoped protocol lookup for settled foreground invocation cards. */
import type { ArtifactRef } from "@meridian/contracts/interrupt";
import { type Block, blockContentRecord, type JsonValue } from "@meridian/contracts/protocol";
import { isArtifactRef } from "./ArtifactGrid";
import { componentBlockContent } from "./component-block-content";

type Invocation = {
  parentTurnId?: string;
  toolCallId?: string;
  childThreadId?: string;
  deliveryMode?: string;
  execution?: string | null;
};

export type DirectInvocationResult = {
  execution: string;
  /** Null means the direct tool settled without saved terminal evidence. */
  outcome: "succeeded" | "failed" | "cancelled" | null;
  summary: string;
  payload?: JsonValue;
  artifacts: ArtifactRef[];
  partial: boolean;
  message: string | null;
  reason: string | null;
};

type SettledOutput = { output: JsonValue | null; isError: boolean; message: string | null };

/** The complete parent turn is one identity scope; presentation runs are not protocol boundaries. */
export function directResultsForTurn(
  blocks: readonly Block[],
): Map<string, DirectInvocationResult> {
  const names = new Map<string, string>();
  const settled = new Map<string, SettledOutput>();
  for (const block of blocks) {
    if (block.blockType !== "tool_use" && block.blockType !== "tool_result") continue;
    const content = blockContentRecord(block);
    const callId = stringField(content, "toolCallId") ?? stringField(content, "toolUseId");
    if (!callId) continue;
    const key = `${block.turnId}\0${callId}`;
    if (block.blockType === "tool_use") {
      const name = stringField(content, "toolName");
      if (name) names.set(key, name);
      // Live reduction merges the settled result onto the use; durable history has a separate result.
      if (block.status === "complete" && Object.hasOwn(content, "output")) {
        settled.set(key, outputFields(content));
      }
    } else {
      settled.set(key, outputFields(content));
    }
  }

  const direct = new Map<string, DirectInvocationResult>();
  for (const block of blocks) {
    if (block.blockType !== "custom") continue;
    const content = componentBlockContent(block.content);
    if (content?.kind !== "helper-result") continue;
    const invocation = content.props as Invocation;
    if (
      invocation.parentTurnId !== block.turnId ||
      invocation.deliveryMode !== "direct" ||
      !invocation.execution ||
      !invocation.toolCallId ||
      !invocation.childThreadId
    )
      continue;
    const key = `${block.turnId}\0${invocation.toolCallId}`;
    const name = names.get(key);
    if (name !== "spawn" && name !== "thread_message") continue;
    const result = settled.get(key);
    if (!result) continue;
    const envelope = resultEnvelope(result.output, result.isError, result.message);
    if (envelope?.execution === invocation.execution) direct.set(block.id, envelope);
  }
  return direct;
}

function outputFields(content: Record<string, JsonValue>): SettledOutput {
  return {
    output: content.output ?? null,
    isError: content.isError === true,
    message: stringField(content, "message"),
  };
}

function resultEnvelope(
  output: JsonValue | null,
  isError: boolean,
  toolMessage: string | null,
): DirectInvocationResult | null {
  if (!isRecord(output) || typeof output.execution !== "string") return null;
  const outcome = output.outcome;
  if (output.status !== "completed" && output.status !== "error") return null;
  if (
    outcome !== undefined &&
    outcome !== "succeeded" &&
    outcome !== "failed" &&
    outcome !== "cancelled"
  )
    return null;
  if (outcome === undefined && output.status !== "error") return null;
  const report = isRecord(output.report) ? output.report : null;
  const summary = report && typeof report.summary === "string" ? report.summary : "";
  const error = isRecord(output.error) ? output.error : null;
  const reason = typeof output.reason === "string" ? output.reason : null;
  const message =
    error && typeof error.message === "string"
      ? error.message
      : isError && !summary
        ? toolMessage
        : null;
  return {
    execution: output.execution,
    outcome: outcome ?? null,
    summary,
    ...(report && Object.hasOwn(report, "payload") ? { payload: report.payload } : {}),
    artifacts:
      report && Array.isArray(report.artifacts) ? report.artifacts.filter(isArtifactRef) : [],
    partial: output.partial === true || (outcome !== undefined && outcome !== "succeeded"),
    message,
    reason,
  };
}

function stringField(value: Record<string, JsonValue>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
