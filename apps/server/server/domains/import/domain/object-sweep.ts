/** Prefix reclamation, abandoned-upload expiry, and entry retention. Header identities survive forever. */
import type { ObjectStorePort } from "../../storage/index.js";
import type { ImportRepository } from "../ports/import-repository.js";
import { IMPORT_LIMITS } from "./manifest.js";
import { stagingKeyTime } from "./staging-key.js";
export interface ImportSweepResult {
  swept: number;
  failed: { importId: string; cause: unknown }[];
}
export async function sweepImportObjects(
  repository: ImportRepository,
  objects: ObjectStorePort,
  input: { importId?: string } = {},
): Promise<ImportSweepResult> {
  const candidates = input.importId
    ? [await repository.read(input.importId)].filter((row) => row !== null)
    : await repository.maintenanceCandidates(IMPORT_LIMITS.sweepBatch);
  const result: ImportSweepResult = { swept: 0, failed: [] };
  for (const candidate of candidates) {
    const snapshot = await repository.transaction(async () => {
      const record = await repository.lock(candidate.id);
      if (!record) return null;
      const now = await repository.now();
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
        now.getTime() - record.lastActivityAt.getTime() > IMPORT_LIMITS.expiryMs &&
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
        now,
      };
    });
    if (!snapshot) continue;
    const { record, entries, now } = snapshot;
    const terminal = record.state === "finished" || record.state === "cancelled";
    const protectedKeys = new Set(
      entries.flatMap((entry) => {
        if (!terminal) return [entry.objectKey, entry.convertedKey].filter((key) => key !== null);
        return entry.objectKey && entry.state === "organized" && entry.spec.fileKind === "binary"
          ? [entry.objectKey]
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
          (!terminal && now.getTime() - stagingKeyTime(key) <= IMPORT_LIMITS.orphanAgeMs))
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
    await repository.transaction(async () => {
      const current = await repository.lock(record.id);
      if (!current || current.state !== record.state) return;
      const final =
        terminal &&
        record.finishedAt &&
        now.getTime() - record.finishedAt.getTime() >= 24 * 60 * 60 * 1000;
      await repository.update(record.id, {
        objectsSweptAt: now,
        ...(final ? { finalSweepAt: now } : {}),
      });
      if (
        record.projectId === null ||
        (terminal &&
          record.acknowledgedAt &&
          now.getTime() - record.acknowledgedAt.getTime() > IMPORT_LIMITS.retentionMs)
      )
        await repository.deleteEntries(record.id);
    });
  }
  return result;
}
