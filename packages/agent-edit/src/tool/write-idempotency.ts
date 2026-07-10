// tool_use_id replay cache for the write command surface.
import type { ActorSession } from "../ports/actor-session-store.js";
import type { WriteContext, WriteOutcome } from "./types.js";
import type { CreateWriteToolOptions } from "./write-deps.js";

const DEFAULT_IDEMPOTENCY_ENTRIES = 500;

export interface WriteIdempotencyCache {
  get(cacheKey: string): WriteOutcome | undefined;
  remember(cacheKey: string, outcome: WriteOutcome): void;
  cacheKeyForToolUse(
    session: ActorSession,
    context: WriteContext,
    toolUseId: string | undefined,
  ): string | undefined;
  notifyHit(
    session: ActorSession,
    context: WriteContext,
    toolUseId: string | undefined,
    outcome: WriteOutcome,
  ): void;
}

export function createWriteIdempotencyCache(
  options: Pick<CreateWriteToolOptions, "idempotency" | "onIdempotencyHit">,
): WriteIdempotencyCache {
  const idempotency = new Map<string, WriteOutcome>();
  const maxEntries = options.idempotency?.maxEntries ?? DEFAULT_IDEMPOTENCY_ENTRIES;

  return {
    get: (cacheKey) => idempotency.get(cacheKey),
    remember(cacheKey, outcome) {
      idempotency.set(cacheKey, outcome);
      while (idempotency.size > maxEntries) {
        const oldest = idempotency.keys().next().value;
        if (oldest === undefined) break;
        idempotency.delete(oldest);
      }
    },
    cacheKeyForToolUse: (session, context, toolUseId) =>
      cacheKeyForToolUse(session, context, toolUseId),
    notifyHit(session, context, toolUseId, outcome) {
      notifyIdempotencyHit(options, session, context, toolUseId, outcome);
    },
  };
}

function cacheKeyForToolUse(
  session: ActorSession,
  context: WriteContext,
  toolUseId: string | undefined,
): string | undefined {
  if (!toolUseId) return undefined;
  const scope = responseOrTurnScope(context);
  return scope
    ? `${session.id}\u0000${scope.kind}:${scope.id}\u0000${toolUseId}`
    : `${session.id}\u0000${toolUseId}`;
}

function notifyIdempotencyHit(
  options: Pick<CreateWriteToolOptions, "onIdempotencyHit">,
  session: ActorSession,
  context: WriteContext,
  toolUseId: string | undefined,
  outcome: WriteOutcome,
): void {
  if (!toolUseId) return;
  const scope = responseOrTurnScope(context);
  options.onIdempotencyHit?.({
    toolUseId,
    scopeKind: scope?.kind ?? null,
    scopeId: scope?.id ?? null,
    sessionId: session.id,
    outcome:
      outcome.status === "success"
        ? { status: outcome.status, phase: outcome.phase }
        : { status: outcome.status },
  });
}

export function scopedToolUseId(
  context: WriteContext,
  toolUseId = context.tool_use_id,
): string | undefined {
  if (!toolUseId) return undefined;
  const scope = responseOrTurnScope(context);
  return scope ? `${scope.kind}:${scope.id}:tool:${toolUseId}` : toolUseId;
}

export function responseOrTurnScope(
  context: WriteContext,
): { kind: "response"; id: string } | { kind: "turn"; id: string } | undefined {
  if (context.responseId) return { kind: "response", id: context.responseId };
  if (context.turnId) return { kind: "turn", id: context.turnId };
  return undefined;
}
