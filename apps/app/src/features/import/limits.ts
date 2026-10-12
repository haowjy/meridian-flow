/** Import limits the browser enforces before anything is sent. The server holds the same numbers. */
export const IMPORT_FILE_LIMITS = {
  /** Files in one import. */
  files: 10_000,
  /** Bytes in one import. */
  totalBytes: 2 * 1024 ** 3,
  /** A larger file is listed, never read or sent. */
  fileBytes: 50 * 1024 * 1024,
  /** Bytes one multipart request may carry when it holds more than one file. */
  requestBytes: 8 * 1024 * 1024,
  /** Files one multipart request may carry. */
  partsPerRequest: 200,
  /** The server admits four receives per import; stay under it. */
  concurrentRequests: 3,
  /** Hash this many files at once. */
  concurrentHashes: 6,
  /** Read the first bytes of a file for type sniffing. */
  sniffBytes: 512,
} as const;
