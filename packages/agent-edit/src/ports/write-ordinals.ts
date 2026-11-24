/** The host's per document and chat counter the model's edit handles (`e<N>`) are minted from. */
export interface WriteOrdinals {
  /** Reserve one durable ordinal for `documentId` in `threadId` before it writes an edit. */
  reserveWriteOrdinal(documentId: string, threadId: string): Promise<number>;
}

/** The one place an edit handle is formatted: the model names an edit as `e<n>`. */
export function editHandle(wId: number): string {
  return `e${wId}`;
}

/** The one place an edit handle is parsed. Returns undefined for anything but `e<n>`. */
export function parseEditHandle(handle: string): number | undefined {
  if (!/^e[1-9]\d*$/.test(handle)) return undefined;
  const ordinal = Number(handle.slice(1));
  return Number.isSafeInteger(ordinal) ? ordinal : undefined;
}
