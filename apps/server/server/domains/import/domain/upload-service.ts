/** Upload-first import commands: immutable selection, staged receipts, and short row-locked transitions. */
import { createHash } from "node:crypto";
import {
  IMPORT_ADMISSION,
  type ImportDetail,
  type ImportFilesResult,
  type ImportSkipsInput,
  type ImportSummary,
} from "@meridian/contracts";
import { splitFrontmatter } from "@meridian/markup/wikilinks";
import { frontmatterAliases } from "../../context/index.js";
import type { ObjectStorePort } from "../../storage/index.js";
import type {
  ImportEntry,
  ImportEntryPatch,
  ImportRecord,
  ImportRepository,
} from "../ports/import-repository.js";
import type { ImportDestination } from "../ports/import-tree-writer.js";
import type { OrganizeWake } from "../ports/organize-wake.js";
import { classify } from "./classify.js";
import { IMPORT_LIMITS, ImportError, selectionFingerprint, validateSelection } from "./manifest.js";
import type { FileReceipt } from "./receipt.js";
import type { ImportAdmission } from "./receive-admission.js";
import { selectionRows } from "./selection.js";
import { stagingKey, stagingKeyTime } from "./staging-key.js";
export interface ImportPart {
  entryId: number;
  bytes: Uint8Array;
  changedAfterPick?: boolean;
  tooLarge?: boolean;
}
export function createImportUploadService(deps: {
  repository: ImportRepository;
  objects: ObjectStorePort;
  tree: ImportDestination;
  admission: ImportAdmission;
  wake: OrganizeWake;
  reportError(cause: unknown): void;
}) {
  const repo = deps.repository;
  async function requireRecord(id: string, projectId: string, lock = false) {
    const record = await (lock ? repo.lock(id) : repo.read(id));
    if (!record || record.projectId !== projectId) throw new ImportError(404, "import_not_found");
    return record;
  }
  function uploading(record: ImportRecord) {
    if (record.state !== "uploading") throw new ImportError(409, "import_not_uploading");
  }
  async function complete(record: ImportRecord) {
    const now = await repo.now();
    const state = (await repo.hasAwaiting(record.id)) ? "uploading" : "organizing";
    await repo.refreshCounts(record.id);
    await repo.update(record.id, { state, lastActivityAt: now });
    return state;
  }
  async function after(id: string, projectId: string) {
    const record = await requireRecord(id, projectId);
    if (record.state === "organizing") deps.wake.wake(id);
    return importSummary(repo, record);
  }
  return {
    async create(projectId: string, userId: string, raw: unknown) {
      const selection = validateSelection(raw);
      const fingerprint = selectionFingerprint(selection);
      await repo.transaction(async () => {
        await repo.lockUser(userId);
        // Identity is global: different users cannot race the same UUID into two projects.
        await repo.lockIdentity(selection.importId);
        const existing = await repo.read(selection.importId);
        if (existing) {
          if (existing.projectId !== projectId || existing.userId !== userId)
            throw new ImportError(409, "import_exists");
          if (existing.fingerprint !== fingerprint)
            throw new ImportError(409, "selection_mismatch");
          return;
        }
        if ((await repo.countOpen(userId)) >= IMPORT_LIMITS.openPerUser)
          throw new ImportError(409, "too_many_open_imports", { limit: IMPORT_LIMITS.openPerUser });
        const { folderId } = await deps.tree.destination(selection.destination.folderUri);
        const { roots, entries } = selectionRows(selection, projectId);
        const now = await repo.now();
        await repo.insert(
          {
            id: selection.importId,
            projectId,
            userId,
            destinationUri: selection.destination.folderUri,
            folderId,
            roots,
            placement: null,
            placementGeneration: 0,
            fingerprint,
            state: entries.some((e) => e.state === "awaiting") ? "uploading" : "organizing",
            counts: {
              files: 0,
              bytes: 0,
              received: 0,
              receivedBytes: 0,
              prepared: 0,
              organized: 0,
              skipped: 0,
              failed: 0,
              needsLook: 0,
            },
            createdAt: now,
            lastActivityAt: now,
            leaseToken: null,
            leaseUntil: null,
            claimsWithoutProgress: 0,
            fellBack: false,
            reason: null,
            revealedAt: null,
            finishedAt: null,
            acknowledgedAt: null,
            objectsSweptAt: null,
            finalSweepAt: null,
          },
          entries,
        );
        await repo.refreshCounts(selection.importId);
      });
      return after(selection.importId, projectId);
    },
    async receive(
      id: string,
      projectId: string,
      readParts: (signal: AbortSignal) => Promise<ImportPart[]>,
    ): Promise<ImportFilesResult> {
      const release = deps.admission.enter(id);
      if (!release) throw new ImportError(429, "import_busy");
      const signal = AbortSignal.timeout(10 * 60 * 1000);
      let pulse: ReturnType<typeof setInterval> | undefined;
      const execute = async (): Promise<ImportFilesResult> => {
        try {
          const record = await requireRecord(id, projectId);
          // A lost final response may be replayed after completion: received parts still answer idempotently.
          pulse = setInterval(() => {
            void repo
              .transaction(async () => {
                const row = await repo.lock(id);
                if (row?.state === "uploading")
                  await repo.update(id, { lastActivityAt: await repo.now() });
              })
              .catch(deps.reportError);
          }, 30_000);
          const parts = await readParts(signal);
          signal.throwIfAborted();
          if (parts.length > IMPORT_ADMISSION.partsPerRequest)
            throw new ImportError(413, "too_many_parts", {
              limit: IMPORT_ADMISSION.partsPerRequest,
            });
          if (new Set(parts.map((p) => p.entryId)).size !== parts.length)
            throw new ImportError(400, "duplicate_import_entry_id");
          if (
            parts.length > 1 &&
            parts.reduce((n, p) => n + p.bytes.byteLength, 0) > IMPORT_ADMISSION.requestBytes
          )
            throw new ImportError(413, "import_request_too_large", {
              limit: IMPORT_ADMISSION.requestBytes,
            });
          const entries = new Map(
            (await repo.entries(id)).filter((e) => e.kind === "file").map((e) => [e.entryId, e]),
          );
          for (const part of parts)
            if (!entries.has(part.entryId)) throw new ImportError(404, "entry_not_found");
          const receipts: {
            entry: ImportEntry;
            part: ImportPart;
            receipt: FileReceipt;
          }[] = [];
          for (const part of parts) {
            signal.throwIfAborted();
            const entry = entries.get(part.entryId) as ImportEntry;
            if (entry.receipt) continue;
            uploading(record);
            if (entry.state !== "awaiting") continue;
            if (part.tooLarge || part.bytes.byteLength > IMPORT_ADMISSION.fileBytes) continue;
            const root = record.roots.find((r) => r.rootId === entry.selection.rootId);
            const filename = entry.selection.path.split("/").at(-1) || root?.name || "";
            const facts = await classify(filename, part.bytes);
            const key = stagingKey(id, part.entryId);
            const put = await deps.objects.put(key, part.bytes, facts.mimeType);
            if (!put.ok) throw new Error(put.error.message);
            receipts.push({
              entry,
              part,
              receipt: {
                objectKey: key,
                receivedSize: part.bytes.byteLength,
                storageUrl: put.value.storageUrl,
                facts,
                sha256: createHash("sha256").update(part.bytes).digest("hex"),
                aliases:
                  facts.kind === "note"
                    ? frontmatterAliases(
                        splitFrontmatter(Buffer.from(part.bytes).toString("utf8")).frontmatter
                          ?.text ?? "",
                      )
                    : [],
              },
            });
          }
          await repo.transaction(async () => {
            const current = await requireRecord(id, projectId, true);
            if (signal.aborted) return;
            if (current.state !== "uploading") return;
            const now = await repo.now();
            const live = new Map((await repo.entries(id)).map((e) => [e.id, e]));
            let receivedBytes = current.counts.receivedBytes;
            const patches: { id: string; patch: ImportEntryPatch }[] = [];
            for (const part of parts) {
              const entry = entries.get(part.entryId) as ImportEntry;
              if (live.get(entry.id)?.state !== "awaiting") continue;
              const receipt = receipts.find((r) => r.entry.id === entry.id);
              if (
                part.tooLarge ||
                part.bytes.byteLength > IMPORT_ADMISSION.fileBytes ||
                receivedBytes + part.bytes.byteLength > IMPORT_ADMISSION.totalBytes
              ) {
                patches.push({ id: entry.id, patch: { state: "failed", reason: "too_large" } });
              } else if (
                receipt &&
                now.getTime() - stagingKeyTime(receipt.receipt.objectKey) <
                  IMPORT_LIMITS.receiptAgeMs
              ) {
                receivedBytes += part.bytes.byteLength;
                patches.push({
                  id: entry.id,
                  patch: {
                    state: "received",
                    reason: part.changedAfterPick ? "changed_after_pick" : null,
                    receipt: receipt.receipt,
                  },
                });
              }
            }
            await repo.updateEntries(id, patches);
            await complete(current);
          });
          const result = await after(id, projectId);
          const answered = new Map((await repo.entries(id)).map((e) => [e.entryId, e]));
          return {
            summary: result,
            entries: parts.map((part) => {
              const entry = answered.get(part.entryId) as ImportEntry;
              return { entryId: part.entryId, state: entry.state, reason: entry.reason };
            }),
          };
        } finally {
          if (pulse) clearInterval(pulse);
          release();
        }
      };
      let onTimeout: () => void = () => {};
      const timeout = new Promise<never>((_, reject) => {
        onTimeout = () => {
          if (pulse) clearInterval(pulse);
          reject(new ImportError(408, "import_busy"));
        };
        signal.addEventListener("abort", onTimeout, { once: true });
      });
      try {
        return await Promise.race([execute(), timeout]);
      } finally {
        signal.removeEventListener("abort", onTimeout);
      }
    },
    async skips(id: string, projectId: string, input: ImportSkipsInput) {
      await repo.transaction(async () => {
        const record = await requireRecord(id, projectId, true);
        uploading(record);
        const entries = new Map(
          (await repo.entries(id)).filter((e) => e.kind === "file").map((e) => [e.entryId, e]),
        );
        for (const item of input.entries)
          if (!entries.has(item.entryId)) throw new ImportError(404, "entry_not_found");
        for (const reason of ["unreadable", "not_found"] as const) {
          const ids = input.entries
            .filter((item) => item.reason === reason)
            .map((item) => (entries.get(item.entryId) as ImportEntry).id);
          if (ids.length)
            await repo.transitionEntries(id, ["awaiting"], { state: "skipped", reason }, ids);
        }
        await complete(record);
      });
      return after(id, projectId);
    },
    async stop(id: string, projectId: string) {
      await repo.transaction(async () => {
        const record = await requireRecord(id, projectId, true);
        if (record.revealedAt || record.state === "finished")
          throw new ImportError(409, "import_finished");
        if (record.state === "cancelled") return;
        const now = await repo.now();
        await repo.update(id, {
          state: "cancelled",
          acknowledgedAt: now,
          finishedAt: now,
          lastActivityAt: now,
          objectsSweptAt: null,
          finalSweepAt: null,
          leaseToken: null,
          leaseUntil: null,
        });
      });
      return after(id, projectId);
    },
    async retry(id: string, projectId: string) {
      await repo.transaction(async () => {
        const record = await requireRecord(id, projectId, true);
        if (record.state !== "failed") throw new ImportError(409, "import_not_failed");
        await repo.update(id, {
          state: "organizing",
          claimsWithoutProgress: 0,
          reason: null,
          leaseToken: null,
          leaseUntil: null,
          acknowledgedAt: null,
          lastActivityAt: await repo.now(),
        });
      });
      return after(id, projectId);
    },
    async acknowledge(id: string, projectId: string) {
      await repo.transaction(async () => {
        const record = await requireRecord(id, projectId, true);
        if (!["finished", "cancelled"].includes(record.state))
          throw new ImportError(409, "import_not_finished");
        const now = await repo.now();
        if (!record.acknowledgedAt)
          await repo.update(id, { acknowledgedAt: now, lastActivityAt: now });
      });
      await after(id, projectId);
    },
    async detail(id: string, projectId: string): Promise<ImportDetail> {
      return repo.transaction(async () => {
        const record = await requireRecord(id, projectId, true);
        const entries = await repo.entries(id);
        return {
          ...(await importSummary(repo, record)),
          roots: record.roots.map(({ id: _id, created: _created, ...root }) => root),
          entries: entries
            .filter((e) => e.entryId !== null)
            .map((e) => ({
              entryId: e.entryId as number,
              rootId: e.selection.rootId,
              path: e.selection.path,
              size: e.selection.size,
              modifiedAt: e.selection.modifiedAt,
              state: e.state,
              reason: e.reason,
              reasonParams: e.selection.reasonParams,
              documentId: e.id,
            })),
        };
      });
    },
    async listOpen(userId: string) {
      return Promise.all(
        (await repo.listOpen(userId)).map((record) => importSummary(repo, record)),
      );
    },
  };
}

export async function importSummary(
  repo: ImportRepository,
  record: ImportRecord,
): Promise<ImportSummary> {
  const root = record.roots.length === 1 ? record.roots[0] : null;
  return {
    importId: record.id,
    projectId: record.projectId as string,
    state: record.state,
    label: {
      kind: root?.meridianExport ? "export" : root?.kind === "folder" ? "folder" : "files",
      name: root?.name ?? "",
      count: record.counts.files,
    },
    destination: {
      folderUri: record.destinationUri,
      folderId: record.folderId,
      fellBack: record.fellBack,
    },
    root:
      root?.kind === "folder" && root.id
        ? { id: root.id, name: root.name, created: root.created }
        : null,
    counts: record.counts,
    waiting: await repo.waiting(record),
    lastActivityAt: record.lastActivityAt.toISOString(),
    reason: record.reason,
  };
}
