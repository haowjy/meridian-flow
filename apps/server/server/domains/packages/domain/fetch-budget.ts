import { type FetchBudget, FetchBudgetError } from "../ports/package-fetcher.js";

const MB = 1024 * 1024;

/** Starting values from the foreign-import design, to tune. */
export const FETCH_LIMITS = {
  downloadBytes: 50 * MB,
  expandedBytes: 200 * MB,
  entries: 20_000,
  wallTimeMs: 60_000,
} as const;

export type FetchLimits = { -readonly [K in keyof typeof FETCH_LIMITS]: number };

/** One per import; every fetch the import makes draws on it. */
export function createFetchBudget(
  limits: FetchLimits = FETCH_LIMITS,
  now: () => number = Date.now,
): FetchBudget {
  const started = now();
  let downloadBytes = 0;
  let expandedBytes = 0;
  let entries = 0;
  const signal = AbortSignal.timeout(limits.wallTimeMs);

  const checkTime = () => {
    if (signal.aborted || now() - started > limits.wallTimeMs) {
      throw new FetchBudgetError("wall-time", `Fetch took longer than ${limits.wallTimeMs} ms`);
    }
  };

  return {
    download(bytes) {
      downloadBytes += bytes;
      if (downloadBytes > limits.downloadBytes) {
        throw new FetchBudgetError("download", `Download is over ${limits.downloadBytes} bytes`);
      }
      checkTime();
    },
    expanded(bytes) {
      expandedBytes += bytes;
      if (expandedBytes > limits.expandedBytes) {
        throw new FetchBudgetError(
          "expanded",
          `Archive expands past ${limits.expandedBytes} bytes`,
        );
      }
    },
    entry() {
      entries += 1;
      if (entries > limits.entries) {
        throw new FetchBudgetError("entries", `Archive has more than ${limits.entries} entries`);
      }
    },
    checkTime,
    signal,
    used: () => ({ downloadBytes, expandedBytes, entries, elapsedMs: now() - started }),
  };
}
