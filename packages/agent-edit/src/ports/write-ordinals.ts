export interface WriteOrdinals {
  reserveWriteOrdinal(documentId: string, threadId: string): Promise<number>;
}

export function editHandle(wId: number): string {
  return `e${wId}`;
}

export function parseEditHandle(handle: string): number | undefined {
  if (!/^e[1-9]\d*$/.test(handle)) return undefined;
  const ordinal = Number(handle.slice(1));
  return Number.isSafeInteger(ordinal) ? ordinal : undefined;
}
