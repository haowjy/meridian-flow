/** A stand-in import server for tests: plans every file as planned, lands what it is sent. */
import {
  type ImportCounts,
  type ImportEntryStatus,
  type ImportFolderStatus,
  type ImportManifest,
  type ImportStatus,
  importNodeId,
} from "@meridian/contracts";
import { ImportRequestError } from "@/client/api/imports-api";
import type { ImportApi } from "./import-api-port";

const rootFolderId = (rootId: number) => `${rootId}:`;

export function fakeImportServer(options: { failSend?: (entryId: number) => boolean } = {}) {
  const entries = new Map<number, ImportEntryStatus>();
  const folders = new Map<string, ImportFolderStatus>();
  let manifest: ImportManifest | null = null;
  let finished = false;
  let planning = false;
  let version = 1;
  const calls = { plan: 0, send: [] as number[][], finish: 0, resume: 0 };
  const counts = (): ImportCounts => {
    const all = [...entries.values()];
    const count = (state: ImportEntryStatus["state"]) =>
      all.filter((e) => e.state === state).length;
    return {
      total: all.filter((e) => e.state !== "skipped").length,
      landed: count("landed"),
      failed: count("failed"),
      arriving: count("planned") + count("landing"),
      deleted: count("deleted"),
      notImported: count("not_imported"),
      skipped: count("skipped"),
    };
  };
  const status = (): ImportStatus => ({
    importId: manifest?.importId ?? "",
    state: finished ? "finished" : planning ? "planning" : "ready",
    destination: { folderUri: manifest?.destination.folderUri ?? "kb://", folderId: null },
    counts: counts(),
    lastActivityAt: new Date().toISOString(),
    version: String(version),
    folders: [...folders.values()],
    roots: (manifest?.roots ?? []).map((root) => ({
      ...root,
      id: folders.get(rootFolderId(root.rootId))?.id ?? null,
    })),
    entries: [...entries.values()],
  });
  const api: ImportApi = {
    async plan(projectId, planned) {
      calls.plan += 1;
      manifest = planned;
      const idOf = (kind: "folder" | "entry", rootId: number, path: string) =>
        importNodeId({ projectId, importId: planned.importId, rootId, kind, path });
      for (const root of planned.roots) {
        if (root.kind !== "folder") continue;
        const id = await idOf("folder", root.rootId, "");
        folders.set(rootFolderId(root.rootId), {
          id,
          parentId: null,
          scheme: "kb",
          name: root.name,
          state: "planned",
        });
      }
      for (const entry of planned.entries) {
        const slash = entry.path.lastIndexOf("/");
        const filename =
          entry.path === ""
            ? (planned.roots.find((root) => root.rootId === entry.rootId)?.name ?? "")
            : entry.path.slice(slash + 1);
        let parentId: string | null = folders.get(rootFolderId(entry.rootId))?.id ?? null;
        if (slash > 0) {
          const dir = entry.path.slice(0, slash);
          parentId = await idOf("folder", entry.rootId, dir);
          if (!folders.has(`${entry.rootId}:${dir}`))
            folders.set(`${entry.rootId}:${dir}`, {
              id: parentId,
              parentId: folders.get(rootFolderId(entry.rootId))?.id ?? null,
              scheme: "kb",
              name: dir.slice(dir.lastIndexOf("/") + 1),
              state: "planned",
            });
        }
        const dot = filename.lastIndexOf(".");
        const extension = dot > 0 ? filename.slice(dot + 1) : "";
        entries.set(entry.entryId, {
          entryId: entry.entryId,
          rootId: entry.rootId,
          path: entry.path,
          filename,
          size: entry.size,
          sha256: entry.sha256,
          documentId: await idOf("entry", entry.rootId, entry.path),
          kind: extension === "md" ? "note" : "binary",
          state: "planned",
          parentId,
          scheme: "kb",
          name: dot > 0 ? filename.slice(0, dot) : filename,
          extension,
          reason: null,
          wanted: true,
        });
      }
      return status();
    },
    async send(_projectId, _importId, parts) {
      calls.send.push(parts.map((part) => part.entryId));
      if (parts.some((part) => options.failSend?.(part.entryId)))
        throw new ImportRequestError(500, null, undefined, "injected");
      for (const part of parts) {
        const entry = entries.get(part.entryId);
        if (entry) entries.set(part.entryId, { ...entry, state: "landed", wanted: false });
      }
      version += 1;
      if (counts().arriving === 0 && counts().failed === 0) finished = true;
      return { entries: parts.map((part) => entries.get(part.entryId) as ImportEntryStatus) };
    },
    async finish() {
      calls.finish += 1;
      for (const [id, entry] of entries)
        if (entry.state !== "landed" && entry.state !== "skipped")
          entries.set(id, { ...entry, state: "not_imported", wanted: false });
      finished = true;
      version += 1;
      return status();
    },
    async resume() {
      calls.resume += 1;
      planning = false;
      return status();
    },
    async status() {
      return status();
    },
    async changes() {
      return status();
    },
    async listOpen() {
      return [];
    },
  };
  return {
    api,
    calls,
    entries,
    /** The next status answers `planning` until `resume` is called. */
    setPlanning: (value: boolean) => (planning = value),
    setFailSend: (fn: (entryId: number) => boolean) => (options.failSend = fn),
  };
}
