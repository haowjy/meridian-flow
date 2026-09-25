/** Pure execution-report identity, capture, terminal immutability and publication policy. */
import type { ArtifactRef } from "@meridian/contracts/interrupt";
import type {
  ExecutionReportDelivery,
  ReturnResultCapture,
  SavedExecutionReport,
} from "@meridian/contracts/spawn";
import type { JsonValue } from "@meridian/contracts/threads";
import { z } from "zod";
import type {
  AdmitExecutionReportInput,
  FinalizeExecutionReportInput,
} from "../ports/repositories.js";
import { ExecutionReportConflictError } from "./execution-report-conflict.js";

const artifactSchema: z.ZodType<ArtifactRef> = z.union([
  z.object({
    type: z.literal("image"),
    url: z.string(),
    label: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  z.object({
    type: z.literal("object"),
    uri: z.string(),
    label: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  z.object({ type: z.literal("liveView"), url: z.string(), expiresAt: z.string().optional() }),
]);

// Storage has already decoded JSON. Validate the capture shape, not JSON syntax again.
const captureSchema = z.object({
  summary: z.string(),
  payload: z.custom<JsonValue>().optional(),
  artifacts: z.array(artifactSchema).optional(),
});

export function decodeReportCapture(value: JsonValue | null): ReturnResultCapture | null {
  return value === null ? null : captureSchema.parse(value);
}

export const reportTerminalSchema = z.union([
  z.object({ outcome: z.null(), source: z.null(), summary: z.null(), terminalAt: z.null() }),
  z.object({
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    source: z.enum(["return_result", "final_assistant", "empty"]),
    summary: z.string(),
    terminalAt: z.string(),
  }),
]);

export const reportPublicationByDelivery = {
  none: "none",
  direct: "pending",
  background_notification: "pending",
} as const satisfies Record<ExecutionReportDelivery, SavedExecutionReport["publication"]>;

function canonical(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const fields = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function reportIdentity(input: AdmitExecutionReportInput) {
  return {
    childThreadId: input.childThreadId,
    assistantTurnId: input.assistantTurnId,
    handle: input.handle,
    origin: input.origin,
    deliveryMode: input.deliveryMode,
    callerThreadId: input.callerThreadId,
    callerTurnId: input.callerTurnId,
    toolCallId: input.toolCallId,
    cardBlockId: input.cardBlockId,
    agentSlug: input.agentSlug ?? null,
    description: input.description ?? null,
  };
}

export function assertReportIdentity(
  report: SavedExecutionReport,
  identity: ReturnType<typeof reportIdentity>,
): void {
  if (
    Object.entries(identity).some(
      ([key, value]) => report[key as keyof SavedExecutionReport] !== value,
    )
  )
    throw new ExecutionReportConflictError("Conflicting execution report admission");
}

export function reportCapture(capture: ReturnResultCapture): ReturnResultCapture {
  return {
    summary: capture.summary,
    ...(capture.payload !== undefined ? { payload: capture.payload } : {}),
    ...(capture.artifacts !== undefined ? { artifacts: capture.artifacts } : {}),
  };
}

export function assertReportCapture(
  report: SavedExecutionReport,
  toolCallId: string,
  capture: ReturnResultCapture,
): void {
  if (report.captureToolCallId !== toolCallId || canonical(report.capture) !== canonical(capture))
    throw new ExecutionReportConflictError("A different return_result was already accepted");
}

export function reportTerminalContent(input: FinalizeExecutionReportInput) {
  return {
    outcome: input.outcome,
    reason: input.reason,
    source: input.source,
    summary: input.summary,
    payload: input.payload,
    artifacts: input.artifacts ?? null,
    costMillicredits: input.costMillicredits ?? null,
  };
}

export function assertReportTerminal(
  report: SavedExecutionReport,
  content: ReturnType<typeof reportTerminalContent>,
): void {
  if (
    Object.entries(content).some(
      ([key, value]) => canonical(report[key as keyof SavedExecutionReport]) !== canonical(value),
    )
  )
    throw new ExecutionReportConflictError(
      "Execution report already has a conflicting terminal outcome",
    );
}
