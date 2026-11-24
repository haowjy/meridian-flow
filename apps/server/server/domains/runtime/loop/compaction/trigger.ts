export const FLOW_ABSOLUTE_CEILING = 400_000;
export const TRIGGER_SHARE = 0.9;

export interface ResolveCompactionTriggerInput {
  inputTierTokens?: number;
  contextWindow: number;
  maxOutputTokens: number;
  responseReserveTokens?: number;
  concurrentRenderSafetyTokens?: number;
}

export function outputReserveTokens(model: { maxOutputTokens: number }): number {
  return Math.min(model.maxOutputTokens, OUTPUT_RESERVE_CEILING_TOKENS);
}

const OUTPUT_RESERVE_CEILING_TOKENS = 65_536;

export interface CompactionTrigger {
  thresholdTokens: number;
  usableWindowTokens: number;
}

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
