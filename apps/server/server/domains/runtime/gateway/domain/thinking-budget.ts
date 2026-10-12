/** Resolve effort against the model budget, independently of a call's output cap. */
import type { GenerateRequest } from "./types.js";

export function thinkingBudgetTokens(
  request: Pick<GenerateRequest, "reasoning" | "providerOptions" | "maxTokens">,
  modelMaxOutputTokens: number,
): number {
  const override = request.providerOptions?.anthropic?.thinking as
    | { type?: string; budget_tokens?: number }
    | undefined;
  if (override) return override.type === "enabled" ? (override.budget_tokens ?? 0) : 0;
  const reasoning = request.reasoning;
  if (!reasoning || reasoning === "disabled") return 0;
  const effort = reasoning === "adaptive" ? "medium" : reasoning.effort;
  const budgets = {
    low: Math.max(1024, Math.floor(modelMaxOutputTokens * 0.25)),
    medium: Math.max(2048, Math.floor(modelMaxOutputTokens * 0.5)),
    high: Math.max(4096, Math.floor(modelMaxOutputTokens * 0.75)),
    max: modelMaxOutputTokens,
  };
  // Anthropic requires budget_tokens < max_tokens. A summary cap is above the
  // existing budget, so this bound cannot change its cached thinking config.
  return Math.min(budgets[effort], (request.maxTokens ?? modelMaxOutputTokens) - 1);
}
