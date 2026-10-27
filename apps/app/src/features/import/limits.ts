/** Browser-only scheduling. What an import admits is `IMPORT_ADMISSION` in contracts. */
export const IMPORT_SCHEDULING = {
  /** The server admits four receives per import; stay under it. */
  concurrentRequests: 3,
  /** Re-picked files hashed at once; each is read whole, up to the 50 MiB file limit. */
  concurrentHashes: 4,
  /** A local read that has not answered by then (a stalled network or FUSE mount) is unreadable. */
  readTimeoutMs: 30_000,
} as const;
