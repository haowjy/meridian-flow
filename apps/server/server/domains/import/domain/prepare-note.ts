/** Prepare pure note conversion with live identity addresses; no binding or write transaction. */
import type { ImportEntry, ImportRecord } from "../ports/import-repository.js";
import type { ImportTreeWriter } from "../ports/import-tree-writer.js";
import {
  createLinkIndex,
  type ImportLinkCandidate,
  obsidianSettings,
  readFrontmatter,
} from "./link-index.js";
import { convertObsidianNote } from "./obsidian-note.js";
export async function prepareImportedNote(
  tree: ImportTreeWriter,
  record: ImportRecord,
  entry: ImportEntry,
  entries: ImportEntry[],
  text: string,
) {
  const root = record.manifest.roots.find((root) => root.rootId === entry.rootId);
  const settings = obsidianSettings(root);
  // Obsidian syntax lives only in Markdown; plain-text files such as `.toml` land unchanged.
  if (entry.kind !== "note" || entry.filetype !== "markdown")
    return { converted: null, settings, root };
  const roots = new Map(record.manifest.roots.map((root) => [root.rootId, root]));
  const inputs = new Map(record.manifest.entries.map((input) => [input.entryId, input]));
  const candidates: ImportLinkCandidate[] = entries
    .filter((item) => item.kind !== "folder" && item.state !== "skipped")
    .map((item) => {
      const root = roots.get(item.rootId);
      const input = item.entryId === null ? undefined : inputs.get(item.entryId);
      return {
        id: item.id,
        uri: item.uri ?? "",
        rankingUri: item.uri ?? "",
        path: root?.kind === "file" ? root.name : item.path,
        rootId: root?.kind === "file" ? null : item.rootId,
        aliases: input?.frontmatter ? readFrontmatter(input.frontmatter).aliases : [],
        kind: item.kind as ImportLinkCandidate["kind"],
        filetype: item.filetype,
      };
    });
  const existing = (record.manifest.existingLinks ?? []).map((candidate) => ({
    ...candidate,
    rankingUri: candidate.uri,
  }));
  const holder = candidates.find((candidate) => candidate.id === entry.id);
  if (holder) holder.uri = (await tree.currentUri(entry.id, "file")) ?? holder.uri;
  const rootNode = entries.find(
    (item) => item.rootId === entry.rootId && item.kind === "folder" && item.path === "",
  );
  const rootUri = rootNode
    ? ((await tree.currentUri(rootNode.id, "folder")) ?? rootNode.uri)
    : record.folderId
      ? await tree.currentUri(record.folderId, "folder")
      : record.manifest.destination.folderUri;
  const aheadFolder =
    settings.newFileLocation === "current"
      ? holder?.uri.slice(0, holder.uri.lastIndexOf("/") + 1)
      : `${rootUri ?? record.manifest.destination.folderUri}${settings.newFileLocation === "folder" && settings.newFileFolderPath ? `${settings.newFileFolderPath.replace(/^\/|\/$/g, "")}/` : ""}`;
  const attachmentFolder =
    settings.attachmentFolderPath === "./"
      ? (holder?.path.split("/").slice(0, -1).join("/") ?? "")
      : settings.attachmentFolderPath;
  let converted = holder
    ? convertObsidianNote(text, {
        source: holder,
        index: createLinkIndex(candidates, existing),
        attachmentFolder,
        aheadFolder: aheadFolder ?? "",
      })
    : null;
  if (converted) {
    // Locate only selected identities this note actually names. A large vault must
    // not do one database location lookup per candidate for every uploaded note.
    for (const targetId of new Set(converted.targets.values())) {
      const target = [...candidates, ...existing].find((candidate) => candidate.id === targetId);
      if (!target) continue;
      const planned = entries.find((item) => item.id === targetId);
      const current = await tree.currentUri(targetId, "file");
      const parent =
        !current && planned?.parentId ? await tree.currentUri(planned.parentId, "folder") : null;
      target.uri =
        current ??
        (parent && planned
          ? `${parent}${planned.name}${planned.extension ? `.${planned.extension}` : ""}`
          : target.uri);
    }
    if (holder)
      converted = convertObsidianNote(text, {
        source: holder,
        index: createLinkIndex(candidates, existing),
        attachmentFolder,
        aheadFolder: aheadFolder ?? "",
      });
  }
  return { converted, settings, root };
}
