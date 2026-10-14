/** Groups files into multipart requests under the server's request limits. */
import { IMPORT_ADMISSION } from "@meridian/contracts";

export type BatchItem = { entryId: number; size: number };

/**
 * A file larger than a request's byte budget travels alone, up to the per-file
 * limit. Everything else packs in order, up to the byte and part budgets.
 */
export function planBatches(items: readonly BatchItem[]): BatchItem[][] {
  const batches: BatchItem[][] = [];
  let current: BatchItem[] = [];
  let bytes = 0;
  const flush = () => {
    if (current.length > 0) batches.push(current);
    current = [];
    bytes = 0;
  };
  for (const item of items) {
    if (item.size > IMPORT_ADMISSION.requestBytes) {
      flush();
      batches.push([item]);
      continue;
    }
    if (
      current.length >= IMPORT_ADMISSION.partsPerRequest ||
      bytes + item.size > IMPORT_ADMISSION.requestBytes
    )
      flush();
    current.push(item);
    bytes += item.size;
  }
  flush();
  return batches;
}
