import type { PromptCacheDescriptor } from "@meridian-flow/runtime/gateway";

const ASK_IDLE_SECONDS = 4 * 60;
const ASK_HARD_LIMIT_CACHE_BUFFER_SECONDS = 5 * 60;
const NO_LIFETIME_HARD_LIMIT_SECONDS = 55 * 60;

export function askHardLimitSeconds(
  promptCache: Pick<PromptCacheDescriptor, "longTtlSeconds"> | null,
): number {
  const lifetime = promptCache?.longTtlSeconds ?? null;
  return lifetime === null
    ? NO_LIFETIME_HARD_LIMIT_SECONDS
    : lifetime - ASK_HARD_LIMIT_CACHE_BUFFER_SECONDS;
}

export function askDeadline(now: Date, openedAt: Date, hardLimitSeconds: number): Date {
  const deadline = Math.min(
    now.getTime() + ASK_IDLE_SECONDS * 1_000,
    openedAt.getTime() + hardLimitSeconds * 1_000,
  );
  return new Date(Math.floor(deadline / 1000) * 1000);
}
