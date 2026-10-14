/** Browser-only scheduling. What an import admits is `IMPORT_ADMISSION` in contracts. */
export const IMPORT_SCHEDULING = {
  /** The server admits four receives per import; stay under it. */
  concurrentRequests: 3,
  /** Hash this many files at once. */
  concurrentHashes: 6,
} as const;
