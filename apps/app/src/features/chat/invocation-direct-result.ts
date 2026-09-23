/** Turn-scoped join from an invocation card to its settled foreground tool result. */
import type { ArtifactRef } from "@meridian/contracts/interrupt";
import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { componentBlockContent } from "./component-block-content";
import { groupDeliverySegments } from "./group-delivery-segments";

type Invocation = {
  parentTurnId?: string;
  toolCallId?: string;
  childThreadId?: string;
  deliveryMode?: string;
  execution?: string | null;
};

export type DirectInvocationResult = {
  execution: string;
  outcome: "succeeded" | "failed" | "cancelled";
  summary: string;
  payload?: JsonValue;
  artifacts: ArtifactRef[];
  partial: boolean;
  message: string | null;
};

/** Reads the complete turn before protocol visibility filtering, so order and reload do not matter. */
export function directResultForInvocation(
  blocks: readonly Block[],
  cardBlock: Block,
): DirectInvocationResult | null {
  const content = componentBlockContent(cardBlock.content);
  if (content?.kind !== "helper-result") return null;
  const invocation = content.props as Invocation;
  if (
    invocation.parentTurnId !== cardBlock.turnId ||
    invocation.deliveryMode !== "direct" ||
    !invocation.execution ||
    !invocation.toolCallId ||
    !invocation.childThreadId
  ) {
    return null;
  }

  for (const segment of groupDeliverySegments([...blocks])) {
    const tools =
      segment.kind === "tool" ? [segment.tool] : segment.kind === "tool-run" ? segment.tools : [];
    for (const tool of tools) {
      if (
        tool.toolCallId !== invocation.toolCallId ||
        (tool.toolName !== "spawn" && tool.toolName !== "thread_message") ||
        tool.status !== "complete"
      ) {
        continue;
      }
      const result = resultEnvelope(tool.output, tool.isError, tool.message);
      if (result?.execution === invocation.execution) return result;
    }
  }
  return null;
}

function resultEnvelope(
  output: JsonValue | null,
  isError: boolean,
  toolMessage: string | null,
): DirectInvocationResult | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const envelope = output as Record<string, JsonValue>;
  if (typeof envelope.execution !== "string") return null;
  const status = envelope.status;
  const outcome = envelope.outcome;
  const report = isRecord(envelope.report) ? envelope.report : null;
  if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "cancelled") return null;
  if (status !== "completed" && status !== "error") return null;
  const message =
    typeof envelope.reason === "string"
      ? envelope.reason
      : report && typeof report.summary === "string"
        ? null
        : toolMessage;
  const artifacts =
    report && Array.isArray(report.artifacts) ? report.artifacts.filter(isArtifactRef) : [];
  const summary = report && typeof report.summary === "string" ? report.summary : "";
  return {
    execution: envelope.execution,
    outcome,
    summary,
    ...(report && Object.hasOwn(report, "payload") ? { payload: report.payload } : {}),
    artifacts,
    partial: envelope.partial === true || outcome !== "succeeded",
    message: message ?? (isError && !summary ? toolMessage : null),
  };
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isArtifactRef(value: JsonValue): value is ArtifactRef {
  return (
    isRecord(value) &&
    (value.type === "object" || value.type === "image") &&
    typeof value.uri === "string" &&
    typeof value.label === "string"
  );
}
