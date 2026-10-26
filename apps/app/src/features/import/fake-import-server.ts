/** Instance-owned durable fake. Uploads complete into organize; tests explicitly advance the build. */
import {
  IMPORT_ADMISSION,
  type ImportDetail,
  type ImportSummary,
  importNodeId,
} from "@meridian/contracts";
import { ImportRequestError } from "@/client/api/imports-api";
import type { ImportApi } from "./import-api-port";
export function fakeImportServer() {
  const records = new Map<string, ImportDetail>();
  const closed = new Set<string>();
  const revealed = new Set<string>();
  const sent: number[][] = [];
  const read = (id: string) => {
    const detail = records.get(id);
    if (!detail) throw new ImportRequestError(404, "import_not_found", undefined, "Missing import");
    return detail;
  };
  const update = (id: string) => {
    const detail = read(id);
    const entries = detail.entries;
    detail.counts = {
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      received: entries.filter((entry) =>
        ["received", "prepared", "organized"].includes(entry.state),
      ).length,
      receivedBytes: entries
        .filter((entry) => ["received", "prepared", "organized"].includes(entry.state))
        .reduce((sum, entry) => sum + entry.size, 0),
      prepared: entries.filter((entry) => entry.state === "prepared").length,
      organized: entries.filter((entry) => entry.state === "organized").length,
      skipped: entries.filter((entry) => entry.state === "skipped").length,
      failed: entries.filter((entry) => entry.state === "failed").length,
      needsLook: entries.filter(
        (entry) =>
          entry.state === "failed" ||
          ["unreadable", "not_found", "changed_after_pick", "kept_as_file"].includes(
            entry.reason ?? "",
          ),
      ).length,
    };
    if (detail.state === "uploading" && !entries.some((entry) => entry.state === "awaiting"))
      detail.state = "organizing";
    detail.lastActivityAt = new Date().toISOString();
    return structuredClone(detail);
  };
  const api: ImportApi = {
    async create(projectId, selection) {
      if (records.has(selection.importId)) return structuredClone(read(selection.importId));
      const root =
        selection.roots.length === 1 && selection.roots[0].kind === "folder"
          ? selection.roots[0]
          : null;
      const id = (rootId: number, path: string, kind: "folder" | "entry") =>
        importNodeId({ projectId, importId: selection.importId, rootId, path, kind });
      records.set(selection.importId, {
        importId: selection.importId,
        projectId,
        state: "uploading",
        label: {
          kind: root ? "folder" : "files",
          name: root?.name ?? "",
          count: selection.entries.length,
        },
        destination: { ...selection.destination, folderId: null, fellBack: false },
        root: root ? { id: id(root.rootId, "", "folder"), name: root.name, created: false } : null,
        waiting: false,
        lastActivityAt: new Date().toISOString(),
        reason: null,
        roots: selection.roots,
        counts: {} as ImportSummary["counts"],
        entries: selection.entries.map((entry) => ({
          ...entry,
          state: entry.size > IMPORT_ADMISSION.fileBytes ? "failed" : "awaiting",
          reason: entry.size > IMPORT_ADMISSION.fileBytes ? "too_large" : null,
          documentId: id(entry.rootId, entry.path, "entry"),
        })),
      });
      return update(selection.importId);
    },
    async send(_project, id, parts) {
      const detail = read(id);
      sent.push(parts.map((part) => part.entryId));
      for (const part of parts) {
        const entry = detail.entries.find((entry) => entry.entryId === part.entryId)!;
        if (entry.state === "awaiting" && detail.state === "uploading") {
          entry.state = "received";
          if (part.changed) entry.reason = "changed_after_pick";
        }
      }
      return {
        entries: parts.map((part) =>
          structuredClone(detail.entries.find((entry) => entry.entryId === part.entryId)!),
        ),
        summary: update(id),
      };
    },
    async skip(_project, id, input) {
      const detail = read(id);
      for (const skip of input.entries) {
        const entry = detail.entries.find((entry) => entry.entryId === skip.entryId)!;
        if (entry.state === "awaiting") {
          entry.state = "skipped";
          entry.reason = skip.reason;
        }
      }
      return update(id);
    },
    async picked(_project, id, input) {
      const detail = read(id);
      for (const item of input.entries) {
        const entry = detail.entries.find((entry) => entry.entryId === item.entryId);
        if (entry?.state === "received") entry.reason = null;
      }
      return update(id);
    },
    async stop(_project, id) {
      const detail = read(id);
      if (detail.state === "finished" || revealed.has(id))
        throw new ImportRequestError(409, "import_finished", undefined, "Finished");
      detail.state = "cancelled";
      closed.add(id);
      return update(id);
    },
    async retry(_project, id) {
      read(id).state = "organizing";
      return update(id);
    },
    async acknowledge(_project, id) {
      closed.add(id);
    },
    async detail(_project, id) {
      return structuredClone(read(id));
    },
    async listOpen() {
      return [...records.values()]
        .filter((detail) => !closed.has(detail.importId))
        .map((detail) => structuredClone(detail));
    },
  };
  return {
    api,
    sent,
    fail(id: string) {
      const detail = read(id);
      detail.state = "failed";
      detail.reason = "organize_failed";
      return update(id);
    },
    advance(id: string, prepared: number, reveal = false, published = true) {
      const detail = read(id);
      let count = 0;
      for (const entry of detail.entries)
        if (["received", "prepared"].includes(entry.state) && count++ < prepared)
          entry.state = reveal ? "organized" : "prepared";
      if (reveal) {
        revealed.add(id);
        detail.state = published ? "finished" : "organizing";
        if (detail.root) detail.root.created = true;
      }
      return update(id);
    },
  };
}
