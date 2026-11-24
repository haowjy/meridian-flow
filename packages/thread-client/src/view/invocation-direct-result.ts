import { type ArtifactRef, isArtifactRef } from "@meridian/contracts/artifacts";
import { parseInvocationCard } from "@meridian/contracts/components";
import { type Block, blockContentRecord, type JsonValue } from "@meridian/contracts/protocol";
import { componentBlockContent } from "./component-block-content";

export type DirectInvocationResult = {
  execution: string;
  outcome: "succeeded" | "failed" | "cancelled" | null;
  summary: string;
  payload?: JsonValue;
  artifacts: ArtifactRef[];
  partial: boolean;
  message: string | null;
  reason: string | null;
};

type SettledResult = { result: JsonValue | null; isError: boolean; message: string | null };

export function directResultsForTurn(
  blocks: readonly Block[],
): Map<string, DirectInvocationResult> {
  const names = new Map<string, string>();
  const settled = new Map<string, SettledResult>();
  for (const block of blocks) {
    if (block.blockType !== "tool_use" && block.blockType !== "tool_result") continue;
    const content = blockContentRecord(block);
    const callId = stringField(content, "toolCallId") ?? stringField(content, "toolUseId");
    if (!callId) continue;
    const key = `${block.turnId}\0${callId}`;
    if (block.blockType === "tool_use") {
      const name = stringField(content, "toolName");
      if (name) names.set(key, name);
      if (block.status === "complete" && Object.hasOwn(content, "result")) {
        settled.set(key, resultFields(content));
      }
    } else {
      settled.set(key, resultFields(content));
    }
  }

  const direct = new Map<string, DirectInvocationResult>();
  for (const block of blocks) {
    if (block.blockType !== "custom") continue;
    const invocation = parseInvocationCard(componentBlockContent(block.content));
    if (!invocation) continue;
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
    const envelope = resultEnvelope(result.result, result.isError, result.message);
    if (
      envelope &&
      (envelope.execution === undefined || envelope.execution === invocation.execution)
    ) {
      direct.set(block.id, { ...envelope, execution: invocation.execution });
    }
  }
  return direct;
}

function resultFields(content: Record<string, JsonValue>): SettledResult {
  return {
    result: content.result ?? null,
    isError: content.isError === true,
    message: stringField(content, "message"),
  };
}

function resultEnvelope(
  typed: JsonValue | null,
  isError: boolean,
  toolMessage: string | null,
): (Omit<DirectInvocationResult, "execution"> & { execution?: string }) | null {
  if (!isRecord(typed)) return null;
  const outcome = typed.outcome;
  if (typed.status !== "completed" && typed.status !== "error") return null;
  if (
    outcome !== undefined &&
    outcome !== "succeeded" &&
    outcome !== "failed" &&
    outcome !== "cancelled"
  )
    return null;
  if (outcome === undefined && typed.status !== "error") return null;
  const report = isRecord(typed.report) ? typed.report : null;
  const summary = report && typeof report.summary === "string" ? report.summary : "";
  const error = isRecord(typed.error) ? typed.error : null;
  const reason = typeof typed.reason === "string" ? typed.reason : null;
  const message =
    error && typeof error.message === "string"
      ? error.message
      : isError && !summary
        ? toolMessage
        : null;
  return {
    ...(typeof typed.execution === "string" ? { execution: typed.execution } : {}),
    outcome: outcome ?? null,
    summary,
    ...(report && Object.hasOwn(report, "payload") ? { payload: report.payload } : {}),
    artifacts:
      report && Array.isArray(report.artifacts) ? report.artifacts.filter(isArtifactRef) : [],
    partial: typed.partial === true || (outcome !== undefined && outcome !== "succeeded"),
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
