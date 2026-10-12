/**
 * Reclaims deterministic binary object keys after terminal entries' leases expire.
 *
 * Only binaries whose landing was claimed can own an object. Each is swept once
 * after its lease and once more after the late-put grace; a late put that records
 * its receipt clears the marker, so the next sweep reclaims it.
 */
import type { ObjectStorePort } from "../../storage/index.js";
import type { ImportRepository } from "../ports/import-repository.js";
import { IMPORT_LIMITS } from "./manifest.js";

export interface ImportSweepResult {
  swept: number;
  failed: { importId: string; entryId: number; cause: unknown }[];
}

export async function sweepImportObjects(
  repository: ImportRepository,
  objects: ObjectStorePort,
  input: { now?: Date; importId?: string } = {},
): Promise<ImportSweepResult> {
  const now = input.now ?? new Date();
  const candidates = await repository.sweepCandidates(now, {
    importId: input.importId,
    limit: IMPORT_LIMITS.sweepBatch,
    graceMs: IMPORT_LIMITS.latePutGraceMs,
  });
  if (!candidates.length) return { swept: 0, failed: [] };
  // Mark before deleting: a put recorded after the mark clears it again.
  await repository.markSwept(
    candidates.map((candidate) => candidate.id),
    now,
  );
  const result: ImportSweepResult = { swept: 0, failed: [] };
  const unswept: string[] = [];
  for (const candidate of candidates) {
    const deleted = await objects.delete(`imports/${candidate.importId}/${candidate.entryId}`);
    if (deleted.ok) result.swept++;
    else {
      unswept.push(candidate.id);
      result.failed.push({
        importId: candidate.importId,
        entryId: candidate.entryId,
        cause: deleted.error,
      });
    }
  }
  if (unswept.length) await repository.markSwept(unswept, null);
  return result;
}
