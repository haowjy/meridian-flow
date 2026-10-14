/** A stand-in import server for tests: plans every file as planned, lands what it is sent. */
import type {
  ImportCounts,
  ImportEntryStatus,
  ImportManifest,
  ImportStatus,
} from "@meridian/contracts";
import { ImportRequestError } from "@/client/api/imports-api";
import type { ImportApi } from "./import-api-port";

export function fakeImportServer(options: { failSend?: (entryId: number) => boolean } = {}) {
  const entries = new Map<number, ImportEntryStatus>();
  let manifest: ImportManifest | null = null;
  let finished = false;
  let version = 1;
  const calls = { plan: 0, send: [] as number[][], finish: 0, resume: 0, dismiss: 0 };
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
    state: finished ? "finished" : "ready",
    destination: { folderUri: manifest?.destination.folderUri ?? "kb://", folderId: null },
    counts: counts(),
    lastActivityAt: new Date().toISOString(),
    version: String(version),
    dismissedAt: null,
    folders: [],
    roots: (manifest?.roots ?? []).map((root) => ({
      ...root,
      id: `root-${root.rootId}`,
      uri: null,
    })),
    entries: [...entries.values()],
  });
  const api: ImportApi = {
    async plan(_projectId, planned) {
      calls.plan += 1;
      manifest = planned;
      for (const entry of planned.entries) {
        entries.set(entry.entryId, {
          entryId: entry.entryId,
          rootId: entry.rootId,
          path: entry.path,
          filename: entry.path.split("/").at(-1) ?? "",
          size: entry.size,
          sha256: entry.sha256,
          documentId: `doc-${entry.entryId}`,
          kind: "note",
          state: "planned",
          uri: null,
          parentId: null,
          scheme: "kb",
          name: entry.path,
          extension: "",
          reason: null,
          exists: true,
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
    async dismiss() {
      calls.dismiss += 1;
      return { ...status(), dismissedAt: new Date().toISOString() };
    },
    async resume() {
      calls.resume += 1;
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
    setFailSend: (fn: (entryId: number) => boolean) => (options.failSend = fn),
  };
}
