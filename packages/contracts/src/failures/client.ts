/** Bounded metadata accepted by client failure diagnostics, never arbitrary error text. */
import { z } from "zod";
import type { EventRecord } from "../observability/index.js";
import type { ClientFailureRecord } from "./index.js";

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9:_-]+$/);
const record = z
  .object({
    occurrenceId: id,
    threadId: z.uuid().optional(),
    turnId: z.uuid().optional(),
    requestId: id.optional(),
    submissionId: z.uuid().optional(),
    failure: z
      .object({
        category: z.enum(["command", "unavailable"]),
        source: z.enum(["transport", "refusal", "validation", "bug"]),
        actionable: z.boolean(),
        cause: z
          .object({
            code: z.enum([
              "lost",
              "refused",
              "unsaved",
              "unwritten",
              "malformed_response",
              "subscribe_refused",
              "socket_closed",
              "request_failed",
              "validation",
              "unknown",
            ]),
            status: z.number().int().min(0).max(65535).optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export const clientFailureRecordSchema = z.discriminatedUnion("phase", [
  record.extend({ phase: z.literal("recorded") }),
  record.extend({
    phase: z.literal("ended"),
    end: z.enum(["resolved", "retried", "moved_on", "forgotten", "dismissed", "moot"]),
  }),
]) satisfies z.ZodType<ClientFailureRecord>;
export const clientFailureBatchSchema = z
  .object({
    accountId: z.uuid(),
    records: z.array(clientFailureRecordSchema).min(1).max(32),
  })
  .strict();

export function clientFailureEvent(record: ClientFailureRecord): EventRecord {
  return {
    timestamp: new Date().toISOString(),
    level: record.failure.source === "bug" ? "error" : "warn",
    source: "client",
    name: `failure.${record.phase}`,
    correlation: {
      ...(record.threadId ? { threadId: record.threadId } : {}),
      ...(record.turnId ? { turnId: record.turnId } : {}),
      ...(record.requestId ? { requestId: record.requestId } : {}),
    },
    payload: {
      occurrenceId: record.occurrenceId,
      category: record.failure.category,
      source: record.failure.source,
      actionable: record.failure.actionable,
      failureCode: record.failure.cause.code,
      ...(record.failure.cause.status === undefined
        ? {}
        : { providerStatus: record.failure.cause.status }),
      ...(record.submissionId ? { submissionId: record.submissionId } : {}),
      ...(record.phase === "ended" ? { end: record.end } : {}),
    },
  };
}
