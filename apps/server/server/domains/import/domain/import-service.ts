/** Plan/resume, leased landing and terminal Finish over explicit storage ports. */
import { createHash, randomUUID } from "node:crypto";
import type {
  ImportFailureReason,
  ImportReport,
  ImportReportChanges,
  ImportSummary,
} from "@meridian/contracts";
import { parseDocumentFilename } from "@meridian/contracts/protocol";
import type { ObjectStorePort } from "../../storage/index.js";
import type { DocumentConverterPort } from "../ports/document-converter.js";
import type { ImportDiagnostics } from "../ports/import-diagnostics.js";
import type { ImportEntry, ImportRecord, ImportRepository } from "../ports/import-repository.js";
import { type ImportTreeWriter, ParentMovedError } from "../ports/import-tree-writer.js";
import { readExportMarker } from "./export-marker.js";
import { IMPORT_LIMITS, ImportError, manifestFingerprint, validateManifest } from "./manifest.js";
import { sweepImportObjects } from "./object-sweep.js";
import { allocateName, planSelection } from "./plan.js";
import { prepareImportedNote } from "./prepare-note.js";

export function createImportService(deps: {
  repository: ImportRepository;
  tree: ImportTreeWriter;
  converter: DocumentConverterPort;
  objects: ObjectStorePort;
  diagnostics: ImportDiagnostics;
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
      destination: record.manifest.destination,
      sort: record.manifest.sort,
      counts: cut.counts,
      lastActivityAt: cut.lastActivityAt,
      version: cut.version,
      dismissedAt: record.dismissedAt?.toISOString() ?? null,
    };
  }
  async function report(id: string, projectId: string): Promise<ImportReport>;
  async function report(id: string, projectId: string, since: string): Promise<ImportReportChanges>;
  async function report(
    id: string,
    projectId: string,
    since?: string,
  ): Promise<ImportReport | ImportReportChanges> {
    const cut = await repo.snapshot(id, projectId, since);
    if (!cut) throw new ImportError(404, "import_not_found");
    const { record, entries } = cut;
    const reportedEntries = await Promise.all(
      entries.filter((entry) => entry.entryId !== null).map((entry) => entryReport(entry)),
    );
    if (since !== undefined) return { ...summary(cut), entries: reportedEntries };
    return {
      ...summary(cut),
      roots: await Promise.all(
        record.manifest.roots.map(async (root) => {
          const node = entries.find(
            (entry) =>
              entry.rootId === root.rootId &&
              (root.kind === "folder"
                ? entry.kind === "folder" && entry.path === ""
                : entry.entryId !== null),
          );
          return {
            rootId: root.rootId,
            kind: root.kind,
            name: root.name,
            id: node?.id ?? null,
            uri: node
              ? ((await tree.currentUri(node.id, root.kind === "folder" ? "folder" : "file")) ??
                node.uri)
              : null,
          };
        }),
      ),
      entries: reportedEntries,
    };
  }
  async function entryReport(entry: ImportEntry) {
    const actual = entry.created ? await tree.currentUri(entry.id, "file") : null;
    const liveName = actual ? parseDocumentFilename(actual.split("/").at(-1) ?? "") : null;
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
      uri: actual ?? entry.uri,
      name: liveName?.ok ? liveName.value.name : entry.name,
      exists: actual !== null,
      reason: entry.reason,
      ...(entry.reasonParams ? { reasonParams: entry.reasonParams } : {}),
      findings: entry.findings,
    };
  }
  async function entryOutcome(id: string, entryId: number) {
    const entry = await repo.fileEntry(id, entryId);
    if (!entry) throw new ImportError(404, "entry_not_found");
    return entryReport(entry);
  }
  async function resume(record: ImportRecord) {
    while (true) {
      const changed = await retryMoved(async () => {
        const locked = await repo.fence(record.id, record.projectId);
        if (locked?.state !== "planning") return false;
        const entries = await repo.entries(record.id);
        const pending = entries.filter((entry) => !entry.prepared && entry.state === "planned");
        const first = pending[0];
        if (!first) {
          await repo.setState(record.id, "ready");
          return false;
        }
        const parent = await tree.parent(
          first.area && !first.parentId
            ? { ...locked, ...(await tree.destination(`${first.area}://`)) }
            : locked,
          first.parentId,
        );
        // One parent per chunk makes lock ordering stable even after cross-area moves.
        const chunk = pending
          .filter((entry) => entry.parentId === first.parentId && entry.area === first.area)
          .slice(0, IMPORT_LIMITS.chunkSize);
        if (parent)
          parent.children.push(
            ...entries
              .filter(
                (entry) =>
                  entry.prepared &&
                  !entry.created &&
                  entry.parentId === first.parentId &&
                  entry.area === first.area &&
                  entry.state === "planned",
              )
              .map((entry) => ({
                kind: "file" as const,
                name: entry.name,
                extension: entry.extension,
              })),
          );
        const allocated: ImportEntry[] = [];
        for (const candidate of chunk) {
          const entry = await repo.lockEntry(candidate.id);
          if (entry.prepared || entry.state !== "planned") continue;
          if (!parent) {
            await repo.updateEntry(entry.id, {
              state: "deleted",
              reason: "folder_deleted",
            });
            continue;
          }
          const node = allocate(entry, parent);
          parent.children.push({
            kind: node.kind === "folder" ? "folder" : "file",
            name: node.name,
            extension: node.extension,
          });
          allocated.push(node);
        }
        if (parent && allocated.length) {
          await tree.create(
            parent,
            allocated.filter((entry) => ["folder", "note", "docx"].includes(entry.kind)),
          );
          for (const entry of allocated)
            await repo.updateEntry(entry.id, {
              ...entry,
              prepared: true,
              created: ["folder", "note", "docx"].includes(entry.kind),
            });
        }
        return true;
      });
      if (!changed) return;
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
      for (const entry of unfinished) await repo.updateEntry(entry.id, { state: "not_imported" });
      await repo.setState(id, "finished");
    });
    await sweep();
    return automatic ? undefined : report(id, projectId);
  }
  const sweep = () => sweepImportObjects(repo, deps.objects, now());

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
  return {
    report,
    renewLease,
    async receiving<T>(id: string, projectId: string, read: () => Promise<T>) {
      await touchUpload(id, projectId);
      const stop = heartbeat(id, -1, () => touchUpload(id, projectId));
      try {
        return await read();
      } finally {
        await stop();
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
      if (readExportMarker(manifest)) manifest.sort = false;
      const fingerprint = manifestFingerprint(manifest);
      let record = await repo.read(manifest.importId, projectId);
      if (!record) {
        const destination = await tree.destination(manifest.destination.folderUri);
        const nodes = planSelection(
          manifest,
          randomUUID,
          destination.folderId,
          await tree.preview(manifest.destination.folderUri),
        );
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
        if (entry.state === "landing" && entry.leaseUntil && entry.leaseUntil > now()) return null;
        const attemptId = randomUUID(),
          leaseUntil = new Date(now().getTime() + IMPORT_LIMITS.leaseMs);
        const prepend = entry.prependOnRetry;
        await repo.updateEntry(entry.id, { state: "landing", attemptId, leaseUntil });
        return { record, entry: { ...entry, attemptId, leaseUntil }, prepend };
      });
      if (!claimed) return await entryOutcome(id, entryId);
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
          !Buffer.from(source.sniff, "base64").equals(Buffer.from(bytes.subarray(0, 512)))
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
        // Nonexistent binaries/code have ahead identities until arrival; retain their planned
        // occurrence-to-id relation separately, never look them up again by an address.
        const liveTargets = new Map<number, string>();
        for (const [occurrence, targetId] of targets) {
          const planned = entries.find((item) => item.id === targetId);
          if (!planned || planned.created) liveTargets.set(occurrence, targetId);
        }
        const bound =
          entry.kind === "binary"
            ? null
            : await tree.bind(entry, converted?.markdown ?? text, liveTargets);
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
              await repo.updateEntry(entry.id, { storageUrl });
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
            if (settings.unreadable)
              findings.push({ code: "settings_unreadable", params: { name: root?.name ?? "" } });
            for (const invalid of bound.invalidTargets)
              findings.push({
                code: "link_target_unavailable",
                params: { documentId: invalid.documentId },
              });
            for (const ref of ahead) {
              const target = await repo.lockEntry(ref.targetId);
              if (target.state === "landed") {
                const settled = await tree.settleAhead(ref.ref, target.id);
                if (settled && settled.documentId !== target.id)
                  findings.push({
                    code: "picture_elsewhere",
                    params: { name: target.name, holderId: entry.id },
                  });
              } else
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
            });
          } else if (!parent) {
            await repo.updateEntry(entry.id, {
              state: "deleted",
              reason: "folder_deleted",
            });
          } else {
            const allocated = allocate({ ...current, storageUrl }, parent);
            await tree.land(parent, allocated, bound, bytes);
            for (const pending of current.pendingRefs) {
              const settled = await tree.settleAhead(pending.ref, entry.id);
              if (settled && settled.documentId !== entry.id)
                allocated.findings.push({
                  code: "picture_elsewhere",
                  params: {
                    name: allocated.name,
                    holderId: pending.holderId,
                    holderUri: (await tree.currentUri(pending.holderId, "file")) ?? undefined,
                  },
                });
            }
            await repo.updateEntry(entry.id, {
              ...allocated,
              state: "landed",
              created: true,
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
      return await entryOutcome(id, entryId);
    },
  };
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
