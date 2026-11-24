import type { GatewayErrorCode } from "../errors/index.js";
import type { SummaryRejectionReason } from "../runtime/summary-outcome.js";

export type FailureCategory = "reply" | "command" | "usage" | "unavailable";
export type FailureSource = "transport" | "refusal" | "provider" | "usage" | "validation" | "bug";
export type FailureEnd = "resolved" | "retried" | "moved_on" | "forgotten" | "dismissed" | "moot";

export type Failure = {
  category: FailureCategory;
  source: FailureSource;
  actionable: boolean;
  cause: { code: string; reason?: string; status?: number };
};

export type FailureRecord = {
  occurrenceId: string;
  failure: Failure;
  threadId: string;
  turnId?: string;
  executionId?: string;
} & ({ phase: "recorded" } | { phase: "ended"; end: FailureEnd; byTurnId?: string });

export type TypedFailureReason =
  | GatewayErrorCode
  | SummaryRejectionReason
  | "compaction_failed"
  | "context_too_large"
  | "context_window_exceeded"
  | "handoff_brief_failed"
  | "interrupted"
  | "orphaned"
  | "shutdown"
  | "credits_exhausted";

const SOURCE_OF: Record<TypedFailureReason, FailureSource> = {
  network_error: "transport",
  server_error: "provider",
  rate_limited: "provider",
  provider_error: "provider",
  content_filtered: "provider",
  invalid_request: "provider",
  context_overflow: "provider",
  context_too_large: "provider",
  context_window_exceeded: "provider",
  max_tokens: "provider",
  request_too_large: "provider",
  tool_use: "provider",
  empty_text: "provider",
  compaction_failed: "provider",
  handoff_brief_failed: "provider",
  auth_error: "bug",
  malformed_response: "bug",
  interrupted: "bug",
  orphaned: "bug",
  shutdown: "bug",
  credits_exhausted: "usage",
};

export type ReplyFailureInput = {
  reason?: string | null;
  code?: string | null;
  status?: number | null;
};

export function classifyReplyFailure(input: ReplyFailureInput): Failure {
  const code = input.reason ?? input.code ?? "unknown";
  const source = Object.hasOwn(SOURCE_OF, code) ? SOURCE_OF[code as TypedFailureReason] : "bug";
  return {
    category: "reply",
    source,
    actionable: true,
    cause: {
      code,
      ...(input.reason && input.code && input.code !== input.reason ? { reason: input.code } : {}),
      ...(typeof input.status === "number" ? { status: input.status } : {}),
    },
  };
}

export type CommandFailureInput = {
  kind: "lost" | "refused" | "unsaved";
  status?: number | null;
  code?: string | null;
};

export function classifyCommandFailure(input: CommandFailureInput): Failure {
  const source: FailureSource =
    input.code === "malformed_response"
      ? "bug"
      : input.kind === "refused"
        ? "refusal"
        : "transport";
  const code = input.code ?? (input.kind === "unsaved" ? "unsaved" : input.kind);
  return {
    category: "command",
    source,
    actionable: true,
    cause: { code, ...(typeof input.status === "number" ? { status: input.status } : {}) },
  };
}

export function usageFailure(reason: string): Failure {
  return { category: "usage", source: "usage", actionable: true, cause: { code: reason } };
}

export type FailureOccurrence = { occurrenceId: string; failure: Failure };

export function classifyUnavailable(code: string, status?: number): Failure {
  return {
    category: "unavailable",
    source: "transport",
    actionable: true,
    cause: { code, ...(status === undefined ? {} : { status }) },
  };
}

export type ClientFailureRecord = FailureOccurrence & {
  threadId?: string;
  turnId?: string;
  requestId?: string;
  submissionId?: string;
} & ({ phase: "recorded" } | { phase: "ended"; end: FailureEnd });

export type ClientRescueRecord = {
  occurrenceId: string;
  phase: "rescued";
  rescue: { kind: "schema-removed-text"; chars: number; passages: number };
};

export type ClientDiagnosticRecord = ClientFailureRecord | ClientRescueRecord;

export interface FailureLog {
  record(record: ClientDiagnosticRecord): void;
}
export const noFailureLog: FailureLog = { record() {} };
export {
  clientFailureBatchSchema,
  clientFailureEvent,
  clientFailureRecordSchema,
} from "./client.js";
