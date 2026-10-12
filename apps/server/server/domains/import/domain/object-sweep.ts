/** Reclaims deterministic object keys only after terminal entries' outstanding leases expire. */
import type { ObjectStorePort } from "../../storage/index.js";
import type { ImportRepository } from "../ports/import-repository.js";
export async function sweepImportObjects(
  repository: ImportRepository,
  objects: ObjectStorePort,
  now = new Date(),
) {
  let swept = 0;
  for (const entry of await repository.sweepCandidates(now)) {
    if (entry.entryId === null) continue;
    const result = await objects.delete(`imports/${entry.importId}/${entry.entryId}`);
    if (!result.ok) throw new Error(result.error.message);
    swept++;
  }
  return swept;
}
