/** Resolves an Agent's autocompaction policy against the model's usable input window. */

export const FLOW_ABSOLUTE_CEILING = 400_000;

export interface ResolveCompactionTriggerInput {
  autocompact?: number | null;
  autocompact_pct?: number | null;
  contextWindow: number;
  maxOutputTokens: number;
  responseReserveTokens?: number;
  concurrentRenderSafetyTokens?: number;
}

export type CompactionTriggerSource = "agent_tokens" | "agent_percent" | "off";

export interface CompactionTrigger {
  thresholdTokens: number | null;
  usableWindowTokens: number;
  source: CompactionTriggerSource;
}

/** Resolves the Agent's trigger to a usable token threshold; no config default is active yet. */
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
    agentTokens != null ? "agent_tokens" : percent != null ? "agent_percent" : "off";
  if (source === "off") return { thresholdTokens: null, usableWindowTokens, source };

  const configured =
    agentTokens ??
    (percent != null ? Math.floor((Math.max(0, percent) / 100) * usableWindowTokens) : null);
  return {
    thresholdTokens: Math.max(
      0,
      Math.min(configured ?? 0, usableWindowTokens, FLOW_ABSOLUTE_CEILING),
    ),
    usableWindowTokens,
    source,
  };
}
