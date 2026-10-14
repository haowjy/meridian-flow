/** Plan/resume, leased landing and terminal Finish over explicit storage ports. */
import { createHash, randomUUID } from "node:crypto";
import type {
  ImportFailureReason,
  ImportScheme,
  ImportStatus,
  ImportStatusChanges,
  ImportSummary,
} from "@meridian/contracts";
import { IMPORT_ADMISSION } from "@meridian/contracts";
import type { ObjectStorePort } from "../../storage/index.js";
import type { DocumentConverterPort } from "../ports/document-converter.js";
import type { ImportDiagnostics } from "../ports/import-diagnostics.js";
import type { ImportEntry, ImportRecord, ImportRepository } from "../ports/import-repository.js";
import { type ImportTreeWriter, ParentMovedError } from "../ports/import-tree-writer.js";
import { IMPORT_LIMITS, ImportError, manifestFingerprint, validateManifest } from "./manifest.js";
import { sweepImportObjects } from "./object-sweep.js";
import { allocateName, planWithDerivedIds } from "./plan.js";
import {
  convertImportedNote,
  isMarkdownNote,
  type SelectionLoader,
  selectionLoader,
} from "./prepared-selection.js";
import { type ImportAdmission, mapBounded } from "./receive-admission.js";

/** Where the writer knows a link target from: its selected path, or an existing document's address. */
/**
 * The one claim policy: an entry takes bytes when planned, failed, or landing under a
 * lapsed lease. A live lease belongs to a running attempt; a lapsed one to a dead process.
 */
function wantsBytes(entry: ImportEntry, at: Date): boolean {
  if (entry.state === "planned" || entry.state === "failed") return true;
  return entry.state === "landing" && !(entry.leaseUntil && entry.leaseUntil > at);
}

export function createImportService(deps: {
  repository: ImportRepository;
  tree: ImportTreeWriter;
  converter: DocumentConverterPort;
  objects: ObjectStorePort;
  diagnostics: ImportDiagnostics;
  admission: ImportAdmission;
  now?: () => Date;
}) {
  const { repository: repo, tree } = deps;
  const now = deps.now ?? (() => new Date());
  async function requireImport(id: string, projectId: string) {
    const record = await repo.read(id, projectId);
    if (!record) throw new ImportError(404, "import_not_found");
    return record;
  }
  async function retryMoved<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await repo.transaction(run);
      } catch (error) {
        if (!(error instanceof ParentMovedError) || attempt >= 10) throw error;
      }
    }
  }
  function allocate(
    entry: ImportEntry,
    parent: NonNullable<Awaited<ReturnType<ImportTreeWriter["parent"]>>>,
  ) {
    const name = allocateName(entry, parent.children);
    return {
      ...entry,
      name,
      uri: `${parent.uri}${name}${entry.extension ? `.${entry.extension}` : ""}${entry.kind === "folder" ? "/" : ""}`,
    };
  }
  /** An export's rows sit in their own areas; every other row is in the destination's. */
  function schemeOf(record: ImportRecord, entry: ImportEntry) {
    return (entry.area ?? record.manifest.destination.folderUri.split("://")[0]) as ImportScheme;
  }
  function summary(cut: {
    record: ImportRecord;
    counts: ImportSummary["counts"];
    lastActivityAt: string;
    version: string;
  }): ImportSummary {
    const { record } = cut;
    return {
      importId: record.id,
      state: record.state,
      destination: { folderUri: record.manifest.destination.folderUri, folderId: record.folderId },
      counts: cut.counts,
      lastActivityAt: cut.lastActivityAt,
      version: cut.version,
      dismissedAt: record.dismissedAt?.toISOString() ?? null,
    };
  }
  /**
   * Publish created entries' live identity into the import's versioned cut. A move or
   * delete becomes an ordinary entry change, so `since` cuts cannot miss it. Rows a
   * landing commit holds are skipped: that commit publishes them, and the next
   * observation compares again.
   */
  async function observe(id: string, projectId: string, entries: readonly ImportEntry[]) {
    const observed = entries.filter(
      (entry) => entry.created && (entry.entryId !== null || entry.path === ""),
    );
    if (!observed.length) return;
    const live = await tree.currentUris({
      files: observed.filter((entry) => entry.kind !== "folder").map((entry) => entry.id),
      folders: observed.filter((entry) => entry.kind === "folder").map((entry) => entry.id),
    });
    const drifted = (entry: ImportEntry) => {
      const uri = live.get(entry.id);
      return uri === undefined ? entry.exists : !entry.exists || uri !== entry.uri;
    };
    const candidates = observed.filter(drifted);
    if (!candidates.length) return;
    await repo.transaction(async () => {
      if (!(await repo.fence(id, projectId))) return;
      const locked = await repo.lockEntries(
        candidates.map((entry) => entry.id),
        { skipLocked: true },
      );
      await repo.updateEntries(
        locked.filter(drifted).map((entry) => {
          const uri = live.get(entry.id);
          return {
            id: entry.id,
            patch: uri === undefined ? { exists: false } : { exists: true, uri },
          };
        }),
      );
    });
  }
  async function status(id: string, projectId: string): Promise<ImportStatus>;
  async function status(id: string, projectId: string, since: string): Promise<ImportStatusChanges>;
  async function status(
    id: string,
    projectId: string,
    since?: string,
  ): Promise<ImportStatus | ImportStatusChanges> {
    await observe(id, projectId, await repo.entries(id));
    const cut = await repo.snapshot(id, projectId, since);
    if (!cut) throw new ImportError(404, "import_not_found");
    const { record, entries } = cut;
    const scheme = (entry: ImportEntry) => schemeOf(record, entry);
    const folders = entries
      .filter((entry) => entry.kind === "folder")
      .map((entry) => ({
        id: entry.id,
        parentId: entry.parentId,
        scheme: scheme(entry),
        name: entry.name,
        state: entry.state,
      }));
    const reportedEntries = entries
      .filter((entry) => entry.entryId !== null)
      .map((entry) => entryStatus(entry, scheme(entry)));
    // A since-cut holds only changed rows: it reports just the roots whose node changed.
    const roots = record.manifest.roots.flatMap((root) => {
      const node = entries.find(
        (entry) =>
          entry.rootId === root.rootId &&
          (root.kind === "folder"
            ? entry.kind === "folder" && entry.path === ""
            : entry.entryId !== null),
      );
      if (!node && since !== undefined) return [];
      return [
        {
          rootId: root.rootId,
          kind: root.kind,
          name: root.name,
          id: node?.id ?? null,
          uri: node?.uri ?? null,
        },
      ];
    });
    return { ...summary(cut), roots, folders, entries: reportedEntries };
  }
  function entryStatus(entry: ImportEntry, scheme: ImportScheme) {
    const exists = entry.created && entry.exists;
    return {
      entryId: entry.entryId as number,
      rootId: entry.rootId,
      path: entry.path,
      filename: entry.filename,
      size: entry.size,
      sha256: entry.sha256,
      documentId: entry.id,
      kind: entry.kind as "note" | "docx" | "code" | "binary",
      state: entry.state,
      uri: entry.uri,
      parentId: entry.parentId,
      scheme,
      name: entry.name,
      extension: entry.extension,
      exists,
      wanted: wantsBytes(entry, now()),
      reason: entry.reason,
      ...(entry.reasonParams ? { reasonParams: entry.reasonParams } : {}),
    };
  }
  async function entryOutcome(id: string, projectId: string, entryId: number) {
    const entry = await repo.fileEntry(id, entryId);
    if (!entry) throw new ImportError(404, "entry_not_found");
    await observe(id, projectId, [entry]);
    const current = (await repo.fileEntry(id, entryId)) ?? entry;
    return entryStatus(current, schemeOf(await requireImport(id, projectId), current));
  }
  /** Ready admission is its own exclusive transition: a shared fence never upgrades. */
  async function admitReady(record: ImportRecord) {
    return repo.transaction(async () => {
      const locked = await repo.fence(record.id, record.projectId, true);
      if (locked?.state !== "planning") return true;
      if (await repo.hasUnprepared(record.id)) return false;
      await repo.setState(record.id, "ready");
      return true;
    });
  }
  async function runPlanning(record: ImportRecord) {
    while (true) {
      const changed = await retryMoved(async () => {
        const locked = await repo.fence(record.id, record.projectId);
        if (locked?.state !== "planning") return "done";
        const group = await repo.nextPlanningGroup(record.id);
        if (!group) return "admit";
        const parent = await tree.parent(
          group.area && !group.parentId
            ? { ...locked, ...(await tree.destination(`${group.area}://`)) }
            : locked,
          group.parentId,
        );
        // One parent per chunk makes lock ordering stable even after cross-area moves.
        const chunk = await repo.lockEntries(
          group.pending.slice(0, IMPORT_LIMITS.chunkSize).map((entry) => entry.id),
        );
        const candidates = chunk.filter((entry) => !entry.prepared && entry.state === "planned");
        if (!parent) {
          await repo.updateEntries(
            candidates.map((entry) => ({
              id: entry.id,
              patch: { state: "deleted", reason: "folder_deleted" },
            })),
          );
          return "chunk";
        }
        parent.children.push(
          ...group.reserved.map((entry) => ({
            kind: "file" as const,
            name: entry.name,
            extension: entry.extension,
          })),
        );
        const allocated = candidates.map((entry) => {
          const node = allocate(entry, parent);
          parent.children.push({
            kind: node.kind === "folder" ? "folder" : "file",
            name: node.name,
            extension: node.extension,
          });
          return node;
        });
        const creates = (entry: ImportEntry) => ["folder", "note", "docx"].includes(entry.kind);
        if (allocated.length) {
          await tree.create(parent, allocated.filter(creates));
          await repo.updateEntries(
            allocated.map((entry) => ({
              id: entry.id,
              patch: {
                name: entry.name,
                uri: entry.uri,
                prepared: true,
                created: creates(entry),
                exists: creates(entry),
              },
            })),
          );
        }
        return "chunk";
      });
      if (changed === "done" || (changed === "admit" && (await admitReady(record)))) return;
    }
  }
  async function finish(id: string, projectId: string, automatic = false) {
    if (automatic && (await repo.hasUnfinished(id))) return;
    await repo.transaction(async () => {
      const record = await repo.fence(id, projectId, true);
      if (!record) throw new ImportError(404, "import_not_found");
      if (record.state === "finished") return;
      if (automatic && (await repo.hasUnfinished(id))) return;
      const entries = await repo.entries(id);
      if (
        automatic &&
        entries.some(
          (entry) =>
            entry.kind !== "folder" && !["landed", "skipped", "deleted"].includes(entry.state),
        )
      )
        return;
      const unfinished = entries.filter(
        (entry) => !["landed", "skipped", "deleted"].includes(entry.state),
      );
      await tree.clearPending(
        unfinished
          .filter((entry) => entry.created && entry.kind !== "folder")
          .map((entry) => entry.id),
      );
      await repo.updateEntries(
        unfinished.map((entry) => ({ id: entry.id, patch: { state: "not_imported" } })),
      );
      // Links bound to a file that never landed stop waiting for it.
      await tree.releaseAhead(
        entries
          .filter(
            (entry) =>
              (entry.kind === "binary" || entry.kind === "code") && entry.state !== "landed",
          )
          .map((entry) => entry.id),
      );
      await repo.setState(id, "finished");
    });
    await sweepFinished(id);
    return automatic ? undefined : status(id, projectId);
  }
  /** Finish is already durable: its own cleanup can only be retried later, never fail it. */
  async function sweepFinished(id: string) {
    try {
      const result = await sweepImportObjects(repo, deps.objects, { now: now(), importId: id });
      for (const failure of result.failed) deps.diagnostics.sweepFailed(failure);
    } catch (cause) {
      deps.diagnostics.sweepFailed({ importId: id, entryId: -1, cause });
    }
  }
  const sweep = () => sweepImportObjects(repo, deps.objects, { now: now() });

  function heartbeat(id: string, entryId: number, pulse: () => Promise<unknown>) {
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
      renewal = renewal
        .then(async () => {
          await pulse();
        })
        .catch((cause) =>
          deps.diagnostics.failed({ importId: id, entryId, code: "server_error", cause }),
        );
    }, 30_000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await renewal;
    };
  }
  async function touchUpload(id: string, projectId: string) {
    await repo.transaction(async () => {
      const record = await repo.fence(id, projectId);
      if (!record) throw new ImportError(404, "import_not_found");
      if (record.state === "planning") throw new ImportError(409, "import_not_ready");
      if (record.state === "ready") await repo.touch(id);
    });
  }
  async function convertDocx(bytes: Uint8Array) {
    try {
      return await deps.converter.convert(bytes);
    } catch (cause) {
      throw new LandingFailure("conversion_failed", cause);
    }
  }
  async function renewLease(projectId: string, id: string, entryId: number, attemptId: string) {
    return repo.transaction(async () => {
      const record = await repo.fence(id, projectId);
      if (record?.state !== "ready") return false;
      const candidate = await repo.fileEntry(id, entryId);
      if (!candidate) return false;
      const entry = await repo.lockEntry(candidate.id);
      if (entry.state !== "landing" || entry.attemptId !== attemptId) return false;
      await repo.updateEntry(entry.id, {
        leaseUntil: new Date(now().getTime() + IMPORT_LIMITS.leaseMs),
      });
      return true;
    });
  }
  function checkParts(parts: readonly { entryId: number; bytes: Uint8Array }[]) {
    if (!parts.length) throw new ImportError(400, "invalid_import_file_parts");
    if (parts.length > IMPORT_ADMISSION.partsPerRequest)
      throw new ImportError(413, "too_many_parts", { limit: IMPORT_ADMISSION.partsPerRequest });
    if (new Set(parts.map((part) => part.entryId)).size !== parts.length)
      throw new ImportError(400, "duplicate_import_entry_id");
    const total = parts.reduce((sum, part) => sum + part.bytes.length, 0);
    // A file larger than a batch travels alone, up to the per-file limit.
    const limit = parts.length > 1 ? IMPORT_ADMISSION.requestBytes : IMPORT_ADMISSION.fileBytes;
    if (total > limit) throw new ImportError(413, "import_request_too_large", { limit });
  }
  /** Claims and lands one file's bytes. `selectionFor` is shared by a receive's Markdown landings. */
  async function landFile(
    projectId: string,
    id: string,
    entryId: number,
    bytes: Uint8Array,
    selectionFor: SelectionLoader,
  ) {
    const claimed = await repo.transaction(async () => {
      const record = await repo.fence(id, projectId);
      if (!record) throw new ImportError(404, "import_not_found");
      const candidate = await repo.fileEntry(id, entryId);
      if (!candidate) throw new ImportError(404, "entry_not_found");
      const entry = await repo.lockEntry(candidate.id);
      if (["landed", "skipped", "deleted", "not_imported"].includes(entry.state)) return null;
      if (record.state !== "ready") throw new ImportError(409, "import_not_ready");
      if (!wantsBytes(entry, now())) return null;
      const attemptId = randomUUID(),
        leaseUntil = new Date(now().getTime() + IMPORT_LIMITS.leaseMs);
      const prepend = entry.prependOnRetry;
      await repo.updateEntry(entry.id, { state: "landing", attemptId, leaseUntil });
      return { record, entry: { ...entry, attemptId, leaseUntil }, prepend };
    });
    if (!claimed) return await entryOutcome(id, projectId, entryId);
    const { record, entry, prepend } = claimed;
    const stopHeartbeat = heartbeat(id, entryId, () =>
      renewLease(projectId, id, entryId, entry.attemptId as string),
    );
    try {
      if (
        bytes.length !== entry.size ||
        createHash("sha256").update(bytes).digest("hex") !== entry.sha256
      )
        throw new LandingFailure(
          "changed_since_chosen",
          new Error("File bytes do not match its SHA-256 digest"),
        );
      const holderUri =
        entry.kind === "note" || entry.kind === "docx"
          ? await tree.currentUri(entry.id, "file")
          : null;
      if ((entry.kind === "note" || entry.kind === "docx") && !holderUri)
        throw new DeletedBeforeArrivalError();
      const source = record.manifest.entries.find((source) => source.entryId === entry.entryId);
      if (
        source?.sniff !== undefined &&
        !Buffer.from(source.sniff, "base64").equals(
          Buffer.from(bytes.subarray(0, IMPORT_ADMISSION.sniffBytes)),
        )
      )
        throw new LandingFailure(
          "changed_since_chosen",
          new Error("File sniff bytes do not match the selection"),
        );
      const text =
        entry.kind === "docx"
          ? await convertDocx(bytes)
          : entry.kind === "binary"
            ? ""
            : Buffer.from(bytes).toString("utf8");
      // Only a Markdown note reads the selection; other kinds touch just their own entry.
      const selection = isMarkdownNote(entry) ? await selectionFor(record) : null;
      const prepared = selection
        ? await convertImportedNote(tree, selection, entry, holderUri, text)
        : null;
      const targets = prepared?.converted.targets ?? new Map<number, string>();
      // Binaries and code land later. Bound by planned id, an unlanded one gets an
      // ahead ref settled to that id on arrival; its address is never resolved.
      const pending = selection?.pending;
      const bound =
        entry.kind === "binary"
          ? null
          : await tree.bind(
              entry,
              prepared
                ? {
                    text: prepared.converted.template,
                    targets,
                    hrefs: prepared.hrefs,
                    pending,
                  }
                : { text },
            );
      let storageUrl = entry.storageUrl;
      if (entry.kind === "binary") {
        const object = await deps.objects.put(
          `imports/${id}/${entry.entryId}`,
          bytes,
          entry.mimeType,
        );
        if (!object.ok) throw new LandingFailure("upload_failed", object.error);
        storageUrl = object.value.storageUrl;
        await repo.transaction(async () => {
          await repo.fence(id, projectId);
          const current = await repo.lockEntry(entry.id);
          if (current.attemptId === entry.attemptId)
            await repo.updateEntry(entry.id, { storageUrl, objectSweptAt: null });
        });
      }
      await retryMoved(async () => {
        const fenced = await repo.fence(id, projectId);
        if (fenced?.state !== "ready") return;
        const parent = ["binary", "code"].includes(entry.kind)
          ? await tree.parent(
              entry.area && !entry.parentId
                ? { ...record, ...(await tree.destination(`${entry.area}://`)) }
                : record,
              entry.parentId,
            )
          : null;
        const liveNote =
          entry.kind === "note" || entry.kind === "docx" ? await tree.lockDocument(entry.id) : true;
        const current = await repo.lockEntry(entry.id);
        if (!liveNote && current.attemptId === entry.attemptId) {
          await tree.clearPending([entry.id]);
          await repo.updateEntry(entry.id, {
            state: "deleted",
            reason: "deleted_before_arrival",
          });
          return;
        }
        if (current.state !== "landing" || current.attemptId !== entry.attemptId) return;
        if (entry.kind === "note" || entry.kind === "docx") {
          if (!bound) throw new Error("Missing bound note");
          const filled = await tree.fill(current, bound, prepend);
          if (filled !== "filled") {
            await repo.updateEntry(entry.id, {
              state: filled === "deleted" ? "deleted" : "failed",
              prependOnRetry: filled === "edited",
              reason: filled === "deleted" ? "deleted_before_arrival" : "edited_before_arrival",
            });
            return;
          }
          if (prepared)
            await tree.setProperties(
              entry.id,
              prepared.converted.properties,
              prepared.converted.aliases,
            );
          await tree.clearPending([entry.id]);
          await repo.updateEntry(entry.id, {
            state: "landed",
            reason: null,
            uri: await tree.currentUri(entry.id, "file"),
            exists: true,
          });
        } else if (!parent) {
          await repo.updateEntry(entry.id, {
            state: "deleted",
            reason: "folder_deleted",
          });
        } else {
          const allocated = allocate({ ...current, storageUrl }, parent);
          await tree.land(parent, allocated, bound, bytes);
          await repo.updateEntry(entry.id, {
            ...allocated,
            state: "landed",
            created: true,
            exists: true,
            reason: null,
          });
        }
      });
    } catch (error) {
      const code =
        error instanceof DeletedBeforeArrivalError
          ? "deleted_before_arrival"
          : error instanceof LandingFailure
            ? error.reason
            : "server_error";
      deps.diagnostics.failed({
        importId: id,
        entryId,
        code,
        cause: error instanceof LandingFailure ? error.cause : error,
      });
      await repo.transaction(async () => {
        const fenced = await repo.fence(id, projectId);
        if (fenced?.state !== "ready") return;
        const current = await repo.lockEntry(entry.id);
        if (current.attemptId === entry.attemptId && current.state === "landing")
          await repo.updateEntry(entry.id, {
            state: error instanceof DeletedBeforeArrivalError ? "deleted" : "failed",
            reason:
              error instanceof DeletedBeforeArrivalError
                ? "deleted_before_arrival"
                : error instanceof LandingFailure
                  ? error.reason
                  : "server_error",
          });
      });
    } finally {
      await stopHeartbeat();
    }
    await finish(id, projectId, true);
    return await entryOutcome(id, projectId, entryId);
  }
  const api = {
    status,
    renewLease,
    /**
     * One multipart request: admitted per import, read under a heartbeat, validated
     * whole before any landing, then landed with bounded concurrency.
     */
    async receive(
      id: string,
      projectId: string,
      read: () => Promise<{ entryId: number; bytes: Uint8Array }[]>,
    ) {
      const leave = deps.admission.enter(id);
      if (!leave)
        throw new ImportError(429, "import_busy", { limit: IMPORT_LIMITS.receivesPerImport });
      try {
        await touchUpload(id, projectId);
        const stop = heartbeat(id, -1, () => touchUpload(id, projectId));
        let parts: { entryId: number; bytes: Uint8Array }[];
        try {
          parts = await read();
        } finally {
          await stop();
        }
        checkParts(parts);
        const record = await requireImport(id, projectId);
        const known = new Set(record.manifest.entries.map((entry) => entry.entryId));
        if (parts.some((part) => !known.has(part.entryId)))
          throw new ImportError(404, "entry_not_found");
        // Every Markdown landing of this request shares one prepared selection.
        const selectionFor = selectionLoader(() => repo.entries(id));
        return {
          entries: await mapBounded(parts, IMPORT_LIMITS.landingConcurrency, (part) =>
            landFile(projectId, id, part.entryId, part.bytes, selectionFor),
          ),
        };
      } finally {
        leave();
      }
    },
    async listOpen(projectId: string) {
      return (await repo.listOpen(projectId)).map(summary);
    },
    async dismiss(id: string, projectId: string) {
      await repo.transaction(async () => {
        const record = await repo.fence(id, projectId, true);
        if (!record) throw new ImportError(404, "import_not_found");
        if (record.state !== "finished") throw new ImportError(409, "import_not_finished");
        if (!record.dismissedAt) await repo.dismiss(id);
      });
      return status(id, projectId);
    },
    finish: (id: string, projectId: string) => finish(id, projectId),
    /** Runs the stored plan's remaining chunks, then the automatic finish, in any state. */
    async resume(id: string, projectId: string) {
      await runPlanning(await requireImport(id, projectId));
      await finish(id, projectId, true);
      return status(id, projectId);
    },
    sweep,
    async plan(projectId: string, userId: string, raw: unknown) {
      const manifest = validateManifest(raw);
      const fingerprint = manifestFingerprint(manifest);
      let record = await repo.read(manifest.importId, projectId);
      if (!record) {
        const destination = await tree.destination(manifest.destination.folderUri);
        const nodes = planWithDerivedIds(manifest, { projectId }, destination.folderId);
        const existingLinks = await tree.existingLinks();
        await repo.transaction(() =>
          repo.insert(
            {
              id: manifest.importId,
              projectId,
              userId,
              manifest: { ...manifest, existingLinks },
              fingerprint,
              ...destination,
              state: "planning",
            },
            nodes,
          ),
        );
        record = await requireImport(manifest.importId, projectId);
      }
      if (record.fingerprint !== fingerprint) throw new ImportError(409, "selection_mismatch");
      return api.resume(record.id, projectId);
    },
    land: (projectId: string, id: string, entryId: number, bytes: Uint8Array) =>
      landFile(
        projectId,
        id,
        entryId,
        bytes,
        selectionLoader(() => repo.entries(id)),
      ),
  };
  return api;
}

class DeletedBeforeArrivalError extends Error {
  constructor() {
    super("deleted_before_arrival");
  }
}

class LandingFailure extends Error {
  constructor(
    readonly reason: ImportFailureReason,
    readonly cause: unknown,
  ) {
    super(reason);
  }
}
