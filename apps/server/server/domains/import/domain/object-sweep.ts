/** Prefix reclamation, abandoned-upload expiry, and entry retention. Header identities survive forever. */
import type { ObjectStorePort } from "../../storage/index.js";
import type { ImportRepository } from "../ports/import-repository.js";
import { IMPORT_MAINTENANCE, maintenanceCutoffs } from "./maintenance-policy.js";
import { stagingKeyTime } from "./staging-key.js";
export interface ImportSweepResult {
  swept: number;
  failed: { importId: string; cause: unknown }[];
}
export async function sweepImportObjects(
  repository: ImportRepository,
  objects: ObjectStorePort,
  input: {
    importId?: string;
    staged?: { discardStaged(stagingId: string, limit?: number): Promise<{ remaining: boolean }> };
  } = {},
): Promise<ImportSweepResult> {
  const now = await repository.now();
  const cutoffs = maintenanceCutoffs(now);
  const candidates = input.importId
    ? [await repository.read(input.importId)].filter((row) => row !== null)
    : await repository.maintenanceCandidates(IMPORT_MAINTENANCE.batch, cutoffs);
  const result: ImportSweepResult = { swept: 0, failed: [] };
  for (const candidate of candidates) {
    const snapshot = await repository.transaction(async () => {
      const record = await repository.lock(candidate.id);
      if (!record) return null;
      if (record.projectId === null && (record.state !== "cancelled" || !record.acknowledgedAt)) {
        await repository.update(record.id, {
          state: "cancelled",
          acknowledgedAt: now,
          finishedAt: now,
          lastActivityAt: now,
          leaseToken: null,
          leaseUntil: null,
          objectsSweptAt: null,
          finalSweepAt: null,
        });
      }

      if (
        record.projectId !== null &&
        record.lastActivityAt < cutoffs.expiryBefore &&
        (record.state === "uploading" || record.state === "failed")
      ) {
        await repository.update(record.id, {
          state: "cancelled",
          reason: "expired",
          finishedAt: now,
          lastActivityAt: now,
          leaseToken: null,
          leaseUntil: null,
          objectsSweptAt: null,
          finalSweepAt: null,
        });
      }
      return {
        record: (await repository.read(record.id))!,
        entries: await repository.entries(record.id),
      };
    });
    if (!snapshot) continue;
    const { record, entries } = snapshot;
    const terminal = record.state === "finished" || record.state === "cancelled";
    const protectedKeys = new Set(
      entries.flatMap((entry) => {
        if (!terminal)
          return [entry.receipt?.objectKey ?? null, entry.convertedKey].filter(
            (key) => key !== null,
          );
        return entry.receipt &&
          entry.state === "organized" &&
          (entry.receipt.facts.kind === "binary" || entry.reason === "kept_as_file")
          ? [entry.receipt.objectKey]
          : [];
      }),
    );
    const keys: string[] = [];
    let cursor: string | undefined;
    let failed = false;
    if (!record.finalSweepAt)
      do {
        const page = await objects.list(`imports/${record.id}/`, { cursor, limit: 500 });
        if (!page.ok) {
          result.failed.push({ importId: record.id, cause: page.error });
          failed = true;
          break;
        }
        cursor = page.value.cursor;
        keys.push(...page.value.keys.map(({ key }) => key));
      } while (cursor);
    // Local and in-memory stores use offset cursors: finish listing before deleting.
    for (const key of keys) {
      if (
        record.projectId !== null &&
        (protectedKeys.has(key) ||
          (!terminal && stagingKeyTime(key) >= cutoffs.orphanBefore.getTime()))
      )
        continue;
      const deleted = await objects.delete(key);
      if (deleted.ok) result.swept++;
      else {
        result.failed.push({ importId: record.id, cause: deleted.error });
        failed = true;
      }
    }
    if (failed) continue;
    if (record.state === "cancelled" && input.staged) {
      const staged = await input.staged.discardStaged(record.id, 500);
      if (staged.remaining) continue;
    }
    await repository.transaction(async () => {
      const current = await repository.lock(record.id);
      if (!current || current.state !== record.state) return;
      const final = terminal && record.finishedAt && record.finishedAt <= cutoffs.finalSweepBefore;
      await repository.update(record.id, {
        objectsSweptAt: now,
        ...(final ? { finalSweepAt: now } : {}),
      });
      if (
        record.projectId === null ||
        (terminal && record.acknowledgedAt && record.acknowledgedAt < cutoffs.retentionBefore)
      )
        await repository.deleteEntries(record.id);
    });
  }
  return result;
}
