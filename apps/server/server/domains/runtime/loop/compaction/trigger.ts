/** Resolves the compaction trigger against the model's usable input window. */

export const FLOW_ABSOLUTE_CEILING = 400_000;
/** Share of the smaller of the input pricing tier and the usable window that compaction waits for. */
export const TRIGGER_SHARE = 0.9;

export interface ResolveCompactionTriggerInput {
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

export interface CompactionTrigger {
  thresholdTokens: number;
  usableWindowTokens: number;
}

/** Resolves the trigger to a usable token threshold; defaults avoid input repricing and respect the usable window. */
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
  const share = Math.floor(
    TRIGGER_SHARE * Math.min(input.inputTierTokens ?? usableWindowTokens, usableWindowTokens),
  );
  return {
    thresholdTokens: Math.min(share, FLOW_ABSOLUTE_CEILING),
    usableWindowTokens,
  };
}
