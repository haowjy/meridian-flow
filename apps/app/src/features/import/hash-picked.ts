/** Hash Continue's re-picked received files a few at a time, for the report against their receipts. */
import type { ImportPickedInput } from "@meridian/contracts";
import { IMPORT_SCHEDULING } from "./limits";
import { sha256File } from "./local-read";
import type { PickedReceived } from "./match-continue";

/**
 * A file that cannot be read is missing evidence: it is left out of the report and its marks stay,
 * so Continue never stalls on it. Stops between files once `signal` aborts.
 */
export async function hashPicked(
  files: readonly PickedReceived[],
  signal: AbortSignal,
): Promise<ImportPickedInput["entries"]> {
  const entries: ImportPickedInput["entries"] = [];
  let next = 0;
  const worker = async () => {
    while (!signal.aborted && next < files.length) {
      const { entryId, file } = files[next++];
      let sha256: string;
      try {
        sha256 = await sha256File(file);
      } catch {
        continue;
      }
      entries.push({ entryId, sha256, size: file.size, modifiedAt: file.lastModified });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(IMPORT_SCHEDULING.concurrentHashes, files.length) }, worker),
  );
  return entries;
}
