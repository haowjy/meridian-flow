/**
 * Flags a lost prompt cache after caching was established in this thread:
 * a prior completed prompt exists, prior read/write activity exists, and a
 * reported current cache read is strictly below half the prior prompt input.
 * A null read is unreported, not zero, and never counts as a reset.
 */
export function isCacheReset(input: {
  previousInputTokens: number | null;
  hasCacheActivity: boolean;
  currentCacheReadTokens: number | null;
}): boolean {
  return (
    input.previousInputTokens !== null &&
    input.hasCacheActivity &&
    input.currentCacheReadTokens !== null &&
    input.currentCacheReadTokens < input.previousInputTokens * 0.5
  );
}
