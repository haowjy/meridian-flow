/** Plan/resume, leased landing and terminal Finish over explicit storage ports. */
import { createHash, randomUUID } from "node:crypto";
import type {
  ImportFailureReason,
  ImportReport,
  ImportReportChanges,
  ImportSummary,
} from "@meridian/contracts";
import { IMPORT_ADMISSION } from "@meridian/contracts";
import { parseDocumentFilename } from "@meridian/contracts/protocol";
import { walkLinkOccurrences } from "@meridian/markup/links";
import type { ObjectStorePort } from "../../storage/index.js";
import type { DocumentConverterPort } from "../ports/document-converter.js";
import type { ImportDiagnostics } from "../ports/import-diagnostics.js";
import type { ImportEntry, ImportRecord, ImportRepository } from "../ports/import-repository.js";
import { type ImportTreeWriter, ParentMovedError } from "../ports/import-tree-writer.js";
import { IMPORT_LIMITS, ImportError, manifestFingerprint, validateManifest } from "./manifest.js";
import { sweepImportObjects } from "./object-sweep.js";
import { allocateName, planSelection } from "./plan.js";
import { prepareImportedNote } from "./prepare-note.js";
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

function targetPath(record: ImportRecord, entries: readonly ImportEntry[], id: string): string {
  const selected = entries.find((entry) => entry.id === id);
  if (selected) {
    const root = record.manifest.roots.find((root) => root.rootId === selected.rootId);
    return root?.kind === "file" ? root.name : selected.path;
  }
  return record.manifest.existingLinks?.find((candidate) => candidate.id === id)?.uri ?? "";
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
    const findings = [...entry.findings];
    if (name !== entry.name)
      findings.push({
        code: "name_clash",
        params: { original: entry.name + (entry.extension ? `.${entry.extension}` : "") },
      });
    return {
      ...entry,
      name,
      findings,
      uri: `${parent.uri}${name}${entry.extension ? `.${entry.extension}` : ""}${entry.kind === "folder" ? "/" : ""}`,
    };
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
      sort: record.manifest.sort,
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
  async function report(id: string, projectId: string): Promise<ImportReport>;
  async function report(id: string, projectId: string, since: string): Promise<ImportReportChanges>;
  async function report(
    id: string,
    projectId: string,
    since?: string,
  ): Promise<ImportReport | ImportReportChanges> {
    await observe(id, projectId, await repo.entries(id));
    const cut = await repo.snapshot(id, projectId, since);
    if (!cut) throw new ImportError(404, "import_not_found");
    const { record, entries } = cut;
    const reportedEntries = entries
      .filter((entry) => entry.entryId !== null)
      .map((entry) => entryReport(entry));
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
    return { ...summary(cut), roots, entries: reportedEntries };
  }
  function entryReport(entry: ImportEntry) {
    const exists = entry.created && entry.exists;
    const liveName = exists ? parseDocumentFilename(entry.uri?.split("/").at(-1) ?? "") : null;
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
      name: liveName?.ok ? liveName.value.name : entry.name,
      exists,
      wanted: wantsBytes(entry, now()),
      reason: entry.reason,
      ...(entry.reasonParams ? { reasonParams: entry.reasonParams } : {}),
      findings: entry.findings,
    };
  }
  async function entryOutcome(id: string, projectId: string, entryId: number) {
    const entry = await repo.fileEntry(id, entryId);
    if (!entry) throw new ImportError(404, "entry_not_found");
    await observe(id, projectId, [entry]);
    return entryReport((await repo.fileEntry(id, entryId)) ?? entry);
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
  async function resume(record: ImportRecord) {
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
                findings: entry.findings,
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
    return automatic ? undefined : report(id, projectId);
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
  const api = {
    report,
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
        return {
          entries: await mapBounded(parts, IMPORT_LIMITS.landingConcurrency, (part) =>
            api.land(projectId, id, part.entryId, part.bytes),
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
      return report(id, projectId);
    },
    finish: (id: string, projectId: string) => finish(id, projectId),
    sweep,
    async plan(projectId: string, userId: string, raw: unknown) {
      const manifest = validateManifest(raw);
      const fingerprint = manifestFingerprint(manifest);
      let record = await repo.read(manifest.importId, projectId);
      if (!record) {
        const destination = await tree.destination(manifest.destination.folderUri);
        const nodes = planSelection(manifest, randomUUID, destination.folderId);
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
      await resume(record);
      await finish(record.id, projectId, true);
      return report(record.id, projectId);
    },
    async land(projectId: string, id: string, entryId: number, bytes: Uint8Array) {
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
        if (
          (entry.kind === "note" || entry.kind === "docx") &&
          !(await tree.currentUri(entry.id, "file"))
        )
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
          entry.kind === "docx" ? await convertDocx(bytes) : Buffer.from(bytes).toString("utf8");
        const entries = await repo.entries(id);
        const { converted, settings, root } = await prepareImportedNote(
          tree,
          record,
          entry,
          entries,
          text,
        );
        const targets = converted?.targets ?? new Map<number, string>();
        // Binaries and code land later. Bound by planned id, an unlanded one gets an
        // ahead ref settled to that id on arrival; its address is never resolved.
        const pending = new Set(
          entries
            .filter((item) => item.kind === "binary" || item.kind === "code")
            .map((item) => item.id),
        );
        const bound =
          entry.kind === "binary"
            ? null
            : await tree.bind(
                entry,
                converted
                  ? {
                      text: converted.template,
                      targets,
                      hrefs: converted.hrefs,
                      pending,
                    }
                  : { text },
              );
        const ahead = bound?.aheadRefs.length
          ? tree
              .aheadTargets(
                bound,
                (await tree.currentUri(entry.id, "file")) ?? entry.uri ?? "",
                entries,
                targets,
              )
              .sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0))
          : [];
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
            entry.kind === "note" || entry.kind === "docx"
              ? await tree.lockDocument(entry.id)
              : true;
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
            if (converted)
              await tree.setProperties(entry.id, converted.properties, converted.aliases);
            const findings = [...current.findings, ...(converted?.findings ?? [])];
            if (settings.problem)
              findings.push({
                code: "settings_unreadable",
                params: { name: root?.name ?? "", reason: settings.problem },
              });
            const occurrences = bound.invalidTargets.length
              ? walkLinkOccurrences(bound.blocks)
              : [];
            for (const invalid of bound.invalidTargets)
              findings.push({
                code: "link_target_unavailable",
                params: {
                  text: occurrences[invalid.occurrence]?.label ?? "",
                  path: targetPath(record, entries, invalid.documentId),
                },
              });
            for (const ref of ahead) {
              const target = await repo.lockEntry(ref.targetId);
              if (target.state === "landed") await tree.settleAhead(ref.ref, target.id);
              else
                await repo.updateEntry(target.id, {
                  pendingRefs: [...target.pendingRefs, { holderId: entry.id, ref: ref.ref }],
                });
            }
            await tree.clearPending([entry.id]);
            await repo.updateEntry(entry.id, {
              state: "landed",
              findings,
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
            // Each ref awaits this id alone, so settling it cannot lose to another file.
            for (const pending of current.pendingRefs)
              await tree.settleAhead(pending.ref, entry.id);
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
    },
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
