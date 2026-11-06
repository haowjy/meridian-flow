/** Resolves an Agent's autocompaction policy against the model's usable input window. */

export const FLOW_ABSOLUTE_CEILING = 400_000;

export interface ResolveCompactionTriggerInput {
  autocompact?: number | null;
  autocompact_pct?: number | null;
  inputTierTokens?: number;
  contextWindow: number;
  maxOutputTokens: number;
  responseReserveTokens?: number;
  concurrentRenderSafetyTokens?: number;
}

/**
 * Room to keep free for one more model output when checking whether optional work fits under
 * the usable window. `maxOutputTokens` is the wire cap and can be far larger than any real
 * reply (DeepSeek: 393,216); using it here would push the limit below the compaction trigger
 * and silently disable the notes step and shrink rolling-summary segments. `trigger.ts`'s
 * usable window already subtracts the full cap once.
 */
export function outputReserveTokens(model: { maxOutputTokens: number }): number {
  return Math.min(model.maxOutputTokens, OUTPUT_RESERVE_CEILING_TOKENS);
}

const OUTPUT_RESERVE_CEILING_TOKENS = 65_536;

export type CompactionTriggerSource = "agent_tokens" | "agent_percent" | "config_default";

export interface CompactionTrigger {
  thresholdTokens: number;
  usableWindowTokens: number;
  source: CompactionTriggerSource;
}

/** Resolves the Agent's trigger to a usable token threshold; defaults avoid input repricing and respect the usable window. */
export function resolveCompactionTrigger(input: ResolveCompactionTriggerInput): CompactionTrigger {
  const usableWindowTokens = Math.max(
    0,
    Math.floor(
      input.contextWindow -
        input.maxOutputTokens -
        (input.responseReserveTokens ?? 0) -
        (input.concurrentRenderSafetyTokens ?? 0),
    ),
  );
  const agentTokens = input.autocompact;
  const percent = input.autocompact_pct;
  const source: CompactionTriggerSource =
    agentTokens != null ? "agent_tokens" : percent != null ? "agent_percent" : "config_default";

  const configured =
    agentTokens ??
    (percent != null
      ? Math.floor((Math.max(0, percent) / 100) * usableWindowTokens)
      : Math.floor(
          0.9 * Math.min(input.inputTierTokens ?? usableWindowTokens, usableWindowTokens),
        ));
  return {
    thresholdTokens: Math.max(0, Math.min(configured, usableWindowTokens, FLOW_ABSOLUTE_CEILING)),
    usableWindowTokens,
    source,
  };
}
