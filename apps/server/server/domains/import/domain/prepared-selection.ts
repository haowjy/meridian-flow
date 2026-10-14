/**
 * The selection one receive lands against, prepared once and shared by its Markdown
 * landings, plus the per-note conversion that uses it. Everything here is immutable
 * plan data: current addresses and entry lifecycle state are read per landing, because
 * hrefs must follow moves.
 */
import type { ImportEntry, ImportRecord } from "../ports/import-repository.js";
import type { ImportTreeWriter } from "../ports/import-tree-writer.js";
import {
  createLinkIndex,
  DEFAULT_ROOT_SETTINGS,
  type ImportLinkCandidate,
  type ImportLinkIndex,
  type ImportRootSettings,
} from "./link-index.js";
import { type ConvertedNote, convertNote, respell } from "./note-conversion.js";

export interface PreparedSelection {
  readonly index: ImportLinkIndex;
  /** Selected files as link candidates, by planned id. Their `uri` is the allocation at preparation. */
  readonly candidates: ReadonlyMap<string, ImportLinkCandidate>;
  /** Binaries and code land after notes: a note binds them by ahead ref until they do. */
  readonly pending: ReadonlySet<string>;
  readonly settings: ReadonlyMap<number, ImportRootSettings>;
  /** Each folder root's planned root folder; its `uri` is only the fallback for a missing live one. */
  readonly rootFolders: ReadonlyMap<number, { id: string; uri: string | null }>;
  /** Where a planned file would sit if it has no live address yet. */
  readonly reserved: ReadonlyMap<
    string,
    { parentId: string | null; name: string; extension: string }
  >;
  readonly folderId: string | null;
  readonly destinationUri: string;
}

/** Wiki-style syntax lives only in Markdown; plain-text files such as `.toml` land unchanged. */
export const isMarkdownNote = (entry: ImportEntry) =>
  entry.kind === "note" && entry.filetype === "markdown";

/** The persisted plan: header, planned entries and the existing-document snapshot. */
export interface SelectionPlan {
  record: ImportRecord;
  entries: readonly ImportEntry[];
  existingLinks: readonly ImportLinkCandidate[];
}

export function prepareSelection({
  record,
  entries,
  existingLinks,
}: SelectionPlan): PreparedSelection {
  const roots = new Map(record.roots.map((root) => [root.rootId, root]));
  const candidates = new Map<string, ImportLinkCandidate>();
  const reserved = new Map<string, { parentId: string | null; name: string; extension: string }>();
  const rootFolders = new Map<number, { id: string; uri: string | null }>();
  const pending = new Set<string>();
  for (const item of entries) {
    if (item.kind === "folder") {
      if (item.path === "") rootFolders.set(item.rootId, { id: item.id, uri: item.uri });
      continue;
    }
    reserved.set(item.id, { parentId: item.parentId, name: item.name, extension: item.extension });
    if (item.kind === "binary" || item.kind === "code") pending.add(item.id);
    if (item.state === "skipped") continue;
    const root = roots.get(item.rootId);
    candidates.set(item.id, {
      id: item.id,
      uri: item.uri ?? "",
      rankingUri: item.uri ?? "",
      path: root?.kind === "file" ? root.name : item.path,
      rootId: root?.kind === "file" ? null : item.rootId,
      aliases: item.aliases ?? [],
      kind: item.kind,
      filetype: item.filetype,
    });
  }
  // The existing-name snapshot taken at plan time ranks fallback matches; it never follows moves.
  const existing = existingLinks.map((candidate) => ({
    ...candidate,
    rankingUri: candidate.uri,
  }));
  return {
    index: createLinkIndex([...candidates.values()], existing),
    candidates,
    pending,
    settings: new Map([...roots].map(([rootId, root]) => [rootId, root.settings])),
    rootFolders,
    reserved,
    folderId: record.folderId,
    destinationUri: record.destinationUri,
  };
}

/**
 * Lazily prepares the selection on first use and shares that promise. A receive of only
 * binaries never loads the plan; a failed load is retried by the next landing.
 */
export function selectionLoader(loadPlan: () => Promise<SelectionPlan>) {
  let prepared: Promise<PreparedSelection> | undefined;
  return (): Promise<PreparedSelection> => {
    prepared ??= loadPlan().then(prepareSelection, (error) => {
      prepared = undefined;
      throw error;
    });
    return prepared;
  };
}
export type SelectionLoader = ReturnType<typeof selectionLoader>;

/**
 * Converts one Markdown note against the prepared selection, locating its holder, root
 * folder and link targets through batched address lookups at this moment.
 */
export async function convertImportedNote(
  tree: ImportTreeWriter,
  selection: PreparedSelection,
  entry: ImportEntry,
  holderUri: string | null,
  text: string,
): Promise<{ converted: ConvertedNote; hrefs: Map<number, string> } | null> {
  const source = selection.candidates.get(entry.id);
  if (!source) return null;
  const settings = selection.settings.get(entry.rootId) ?? DEFAULT_ROOT_SETTINGS;
  const current = holderUri ?? source.uri;
  let aheadFolder: string;
  if (settings.newFileLocation === "current")
    aheadFolder = current.slice(0, current.lastIndexOf("/") + 1);
  else {
    const root = selection.rootFolders.get(entry.rootId);
    const folderId = root?.id ?? selection.folderId;
    const live = folderId
      ? ((await tree.currentUris({ files: [], folders: [folderId] })).get(folderId) ?? null)
      : null;
    const rootUri = root
      ? (live ?? root.uri)
      : selection.folderId
        ? live
        : selection.destinationUri;
    const subfolder =
      settings.newFileLocation === "folder" && settings.newFileFolderPath
        ? `${settings.newFileFolderPath.replace(/^\/|\/$/g, "")}/`
        : "";
    aheadFolder = `${rootUri ?? selection.destinationUri}${subfolder}`;
  }
  const attachmentFolder =
    settings.attachmentFolderPath === "./"
      ? source.path.split("/").slice(0, -1).join("/")
      : settings.attachmentFolderPath;
  const converted = convertNote(text, {
    source,
    index: selection.index,
    attachmentFolder,
    aheadFolder,
  });
  // Locate only the identities this note names; a large vault must not look up every candidate.
  const targetIds = [...new Set(converted.targets.values())];
  const live = targetIds.length
    ? await tree.currentUris({ files: targetIds, folders: [] })
    : new Map<string, string>();
  const parentIds = [
    ...new Set(
      targetIds.flatMap((id) => {
        const parentId = live.has(id) ? null : selection.reserved.get(id)?.parentId;
        return parentId ? [parentId] : [];
      }),
    ),
  ];
  const parents = parentIds.length
    ? await tree.currentUris({ files: [], folders: parentIds })
    : new Map<string, string>();
  const uris = new Map<string, string>();
  for (const id of targetIds) {
    const target = selection.reserved.get(id);
    const parent = target?.parentId ? parents.get(target.parentId) : undefined;
    const uri =
      live.get(id) ??
      (parent && target
        ? `${parent}${target.name}${target.extension ? `.${target.extension}` : ""}`
        : undefined);
    if (uri) uris.set(id, uri);
  }
  return { converted, hrefs: respell(converted, uris) };
}
