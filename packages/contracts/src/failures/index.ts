/**
 * The failure vocabulary: what a failure is (category, source, end), the record the server logs at each
 * transition, and the one classifier for a failed reply. Pure: the server, thread-client, the app and
 * `./mf` import it; nothing here logs.
 */
import type { GatewayErrorCode } from "../interrupt/mapping.js";
import type { SummaryRejectionReason } from "../runtime/summary-outcome.js";

export type FailureCategory = "reply" | "command" | "usage" | "unavailable";
export type FailureSource = "transport" | "refusal" | "provider" | "usage" | "validation" | "bug";
export type FailureEnd = "resolved" | "retried" | "moved_on" | "forgotten" | "dismissed" | "moot";

export type Failure = {
  category: FailureCategory;
  source: FailureSource;
  /** Whether the writer can act on it now: an action exists and its target is still there. */
  actionable: boolean;
  /** Diagnostics only, never writer copy or model text. */
  cause: { code: string; reason?: string; status?: number };
};

/** One transition of a failure, as the server logs it: when it was classified, and when it ended. */
export type FailureRecord = {
  /** A turn id for a failed turn; `usage:${threadId}:${episode}` for a usage block. */
  occurrenceId: string;
  failure: Failure;
  threadId: string;
  turnId?: string;
  executionId?: string;
} & ({ phase: "recorded" } | { phase: "ended"; end: FailureEnd; byTurnId?: string });

/** Reasons the server writes with a type. Any other reason a reply carries is an untyped provider code. */
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

/**
 * A `Record` over the union rather than a `switch`: a new typed reason fails typecheck here instead of
 * falling through to `bug`.
 */
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

/** What a settled failed turn says about itself: its typed reason, else the error code it carried. */
export type ReplyFailureInput = {
  reason?: string | null;
  code?: string | null;
  status?: number | null;
};

/** The only place a reply failure's source is chosen. Untyped codes are bugs, visible in the logs. */
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

/**
 * What a command's failed attempt says about itself, the way `classifyAnswer` reads an answer:
 * `lost` is no usable answer (transport, a 5xx or a body that does not validate), `refused` is a
 * definite 4xx the server will give again, and `unsaved` is a command the browser could not keep.
 */
export type CommandFailureInput = {
  kind: "lost" | "refused" | "unsaved";
  /** The HTTP status when there was one. */
  status?: number | null;
  /** The server's error code when it named one. */
  code?: string | null;
};

/** The only place a command failure's source is chosen. A refused command is the writer's to dismiss or redo. */
export function classifyCommandFailure(input: CommandFailureInput): Failure {
  const source: FailureSource =
    input.kind === "lost" ? "transport" : input.kind === "refused" ? "refusal" : "bug";
  const code = input.code ?? (input.kind === "unsaved" ? "unsaved" : input.kind);
  return {
    category: "command",
    source,
    actionable: true,
    cause: { code, ...(typeof input.status === "number" ? { status: input.status } : {}) },
  };
}

/** Usage is a category of its own: `RunState.blocked` needs no classifier. */
export function usageFailure(reason: string): Failure {
  return { category: "usage", source: "usage", actionable: true, cause: { code: reason } };
}
