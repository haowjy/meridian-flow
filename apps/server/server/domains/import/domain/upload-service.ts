/** Upload-first import commands: immutable selection, staged receipts, and short row-locked transitions. */
import type {
  ImportDetail,
  ImportFilesResult,
  ImportPickedInput,
  ImportSkipsInput,
  ImportSummary,
} from "@meridian/contracts";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ObjectStorePort } from "../../storage/index.js";
import type { ImportEntry, ImportRecord, ImportRepository } from "../ports/import-repository.js";
import type { ImportDestination } from "../ports/import-tree-writer.js";
import type { OrganizeWake } from "../ports/organize-wake.js";
import { IMPORT_LIMITS, ImportError, selectionFingerprint, validateSelection } from "./manifest.js";
import { pickedPatches } from "./picked.js";
import { type ImportPart, prepareReceipts, receiptPatches } from "./receipt.js";
import { type ImportAdmission, inReceiveScope } from "./receive-admission.js";
import { selectionRows } from "./selection.js";
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
      return inReceiveScope(
        {
          importId: id,
          admission: deps.admission,
          authorize: () => requireRecord(id, projectId),
          pulse: () =>
            repo.transaction(async () => {
              const row = await repo.lock(id);
              if (row?.state === "uploading")
                await repo.update(id, { lastActivityAt: await repo.now() });
            }),
          reportError: deps.reportError,
        },
        async (record, signal) => {
          // Lost final responses replay even after completion without replacing received bytes.
          const parts = await readParts(signal);
          const candidates = await prepareReceipts(repo, deps.objects, record, parts, signal);
          const entryIds = parts.map((part) => part.entryId);
          await repo.transaction(async () => {
            const current = await requireRecord(id, projectId, true);
            signal.throwIfAborted();
            if (current.state !== "uploading") return;
            const entries = await repo.fileEntries(id, entryIds);
            const patches = receiptPatches(
              candidates,
              entries,
              await repo.now(),
              current.counts.receivedBytes,
            );
            signal.throwIfAborted();
            await repo.updateEntries(id, patches);
            await complete(current);
            // A deadline during a database wait rolls back this transaction as well.
            signal.throwIfAborted();
          });
          const summary = await after(id, projectId);
          const answered = new Map(
            (await repo.fileEntries(id, entryIds)).map((entry) => [entry.entryId, entry]),
          );
          return {
            summary,
            entries: parts.map((part) => {
              const entry = answered.get(part.entryId)!;
              return { entryId: part.entryId, state: entry.state, reason: entry.reason };
            }),
          };
        },
      );
    },
    async skips(id: string, projectId: string, input: ImportSkipsInput) {
      await repo.transaction(async () => {
        const record = await requireRecord(id, projectId, true);
        uploading(record);
        const entries = new Map(
          (
            await repo.fileEntries(
              id,
              input.entries.map((item) => item.entryId),
            )
          ).map((e) => [e.entryId, e]),
        );
        for (const item of input.entries)
          if (!entries.has(item.entryId)) throw new ImportError(404, "entry_not_found");
        const skips = new Map(input.entries.map((item) => [item.entryId, item]));
        for (const reason of ["unreadable", "not_found"] as const) {
          const ids = [...skips.values()]
            .filter((item) => item.reason === reason)
            .map((item) => (entries.get(item.entryId) as ImportEntry).id);
          if (ids.length)
            await repo.transitionEntries(id, ["awaiting"], { state: "skipped", reason }, ids);
        }
        await complete(record);
      });
      return after(id, projectId);
    },
    async picked(id: string, projectId: string, input: ImportPickedInput) {
      await repo.transaction(async () => {
        const record = await requireRecord(id, projectId, true);
        uploading(record);
        const entries = await repo.fileEntries(
          id,
          input.entries.map((item) => item.entryId),
        );
        const known = new Set(entries.map((entry) => entry.entryId));
        for (const item of input.entries)
          if (!known.has(item.entryId)) throw new ImportError(404, "entry_not_found");
        const patches = pickedPatches(
          entries,
          new Map(input.entries.map((item) => [item.entryId, item])),
        );
        if (patches.length) await repo.updateEntries(id, patches);
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
            .filter((e) => e.entryId !== null && !e.selection.derivedFrom)
            .map((e) => ({
              entryId: e.entryId as number,
              rootId: e.selection.rootId,
              path: e.selection.path,
              size: e.selection.size,
              modifiedAt: e.selection.modifiedAt,
              state: e.state,
              reason: e.reason,
              changedAfterUpload: e.changedAfterUpload,
              reasonParams: e.selection.reasonParams,
              documentId: e.id,
            })),
        };
      });
    },
  };
}

export async function queryOpenImports(repo: ImportRepository, userId: string) {
  return Promise.all((await repo.listOpen(userId)).map((record) => importSummary(repo, record)));
}

export async function importSummary(
  repo: ImportRepository,
  record: ImportRecord,
): Promise<ImportSummary> {
  const root = record.roots.length === 1 ? record.roots[0] : null;
  const selected = parseContextUri(record.destinationUri);
  const effective = selected.ok
    ? record.placement?.destinations.find(
        (destination) => destination.area === selected.value.scheme,
      )
    : undefined;
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
      folderUri: effective?.uri ?? record.destinationUri,
      folderId: effective ? effective.folderId : record.folderId,
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
