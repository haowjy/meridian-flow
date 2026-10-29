/**
 * Per-call model decisions, made once by the gateway core where the routed
 * model is known. Adapters only map a `ResolvedCall` to their wire fields; they
 * never re-derive cache lifetimes or clamp efforts themselves.
 */
import {
  type GenerateRequest,
  type ModelInfo,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type ReasoningSupport,
  resolvePromptCacheTtlMs,
} from "./types.js";

/** `default` sends nothing and leaves the model's own default; `off` is only resolved for models that can disable reasoning. */
export type ResolvedReasoning = "default" | "off" | { effort: ReasoningEffort };

export interface ResolvedCall {
  /** Lifetime to put on the wire for cache breakpoints; null when the provider publishes none. */
  cacheTtlMs: number | null;
  /** Whether cache writes are billed at the model's long lifetime. */
  longCacheWrites: boolean;
  reasoning: ResolvedReasoning;
}

/** The supported effort nearest the requested one; a tie goes to the higher effort. */
function nearestEffort(requested: ReasoningEffort, supported: readonly ReasoningEffort[]) {
  const rank = (effort: ReasoningEffort) => REASONING_EFFORTS.indexOf(effort);
  return supported.reduce((best, effort) => {
    const distance = Math.abs(rank(effort) - rank(requested));
    const bestDistance = Math.abs(rank(best) - rank(requested));
    return distance < bestDistance || (distance === bestDistance && rank(effort) > rank(best))
      ? effort
      : best;
  });
}

/**
 * Resolve a canonical reasoning request against the model's facts. `adaptive` and
 * an absent request mean the model's default; `disabled` turns reasoning off only
 * when the model can, otherwise it takes the lowest supported effort.
 */
export function resolveReasoning(
  requested: GenerateRequest["reasoning"],
  support: ReasoningSupport,
): ResolvedReasoning {
  if (requested === undefined || requested === "adaptive") return "default";
  if (requested === "disabled") {
    return support.canDisable ? "off" : { effort: nearestEffort("low", support.efforts) };
  }
  return { effort: nearestEffort(requested.effort, support.efforts) };
}

export function resolveCall(
  request: Pick<GenerateRequest, "promptCacheRetention" | "reasoning">,
  model: Pick<ModelInfo, "promptCache" | "reasoning">,
): ResolvedCall {
  const { promptCache } = model;
  return {
    cacheTtlMs: resolvePromptCacheTtlMs(promptCache, request.promptCacheRetention),
    longCacheWrites: request.promptCacheRetention === "long" && promptCache.longTtlMs !== undefined,
    reasoning: resolveReasoning(request.reasoning, model.reasoning),
  };
}
