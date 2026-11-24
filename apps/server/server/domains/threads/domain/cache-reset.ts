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
