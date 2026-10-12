/** Pure selection-first Obsidian resolution and the shared project fallback ranking. */
import type { ImportManifest } from "@meridian/contracts";
import { locate, rankWikilinkMatches, storedName } from "@meridian/markup/obsidian";
import { parseDocument } from "yaml";
import { codePointOrder } from "./plan.js";

export interface ImportLinkCandidate {
  id: string;
  uri: string;
  rankingUri?: string;
  path: string;
  rootId: number | null;
  aliases: string[];
  kind: "note" | "docx" | "code" | "binary";
  filetype: string;
}
export function readFrontmatter(text: string) {
  const yaml = parseDocument(text, { uniqueKeys: true });
  try {
    const value: unknown = yaml.toJS({ maxAliasCount: 100 });
    const readable =
      !yaml.errors.length &&
      (value === null || (typeof value === "object" && !Array.isArray(value)));
    const aliases = readable && value && "aliases" in value ? value.aliases : null;
    return {
      readable,
      aliases:
        typeof aliases === "string"
          ? [aliases]
          : Array.isArray(aliases)
            ? aliases.filter((alias): alias is string => typeof alias === "string")
            : [],
    };
  } catch {
    return { readable: false, aliases: [] };
  }
}
export function decodedPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
export function normalizedPath(value: string): string {
  const parts: string[] = [];
  for (const segment of decodedPath(value).replace(/^\//, "").split("/")) {
    if (segment === "." || !segment) continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  if (parts.length) parts[parts.length - 1] = storedName(parts.at(-1) ?? "");
  return parts.join("/");
}
export function obsidianSettings(root: ImportManifest["roots"][number] | undefined) {
  if (!root?.appJson)
    return {
      attachmentFolderPath: "",
      newFileLocation: "root",
      newFileFolderPath: "",
      unreadable: false,
    };
  try {
    const value = JSON.parse(root.appJson);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings");
    return {
      attachmentFolderPath:
        typeof value.attachmentFolderPath === "string" ? value.attachmentFolderPath : "",
      newFileLocation: typeof value.newFileLocation === "string" ? value.newFileLocation : "root",
      newFileFolderPath: typeof value.newFileFolderPath === "string" ? value.newFileFolderPath : "",
      unreadable: false,
    };
  } catch {
    return {
      attachmentFolderPath: "",
      newFileLocation: "root",
      newFileFolderPath: "",
      unreadable: true,
    };
  }
}
export function createLinkIndex(
  selected: readonly ImportLinkCandidate[],
  existing: readonly ImportLinkCandidate[],
) {
  function resolveLinkpath(
    linkpath: string,
    source: ImportLinkCandidate,
    attachmentFolder = "",
    embed = false,
  ) {
    const wanted = normalizedPath(linkpath);
    const pool = selected.filter(
      (candidate) =>
        source.rootId === null || candidate.rootId === null || candidate.rootId === source.rootId,
    );
    const exact = pool.filter((candidate) => normalizedPath(candidate.path) === wanted);
    const names = exact.length
      ? exact
      : pool.filter((candidate) => {
          const path = normalizedPath(candidate.path).toLowerCase();
          return path === wanted.toLowerCase() || path.endsWith(`/${wanted.toLowerCase()}`);
        });
    const directory = normalizedPath(source.path).split("/").slice(0, -1).join("/");
    const folder = (candidate: ImportLinkCandidate) =>
      normalizedPath(candidate.path).split("/").slice(0, -1).join("/");
    const byName = [...names].sort(
      (a, b) =>
        Number(folder(b) === directory) - Number(folder(a) === directory) ||
        a.path.split("/").length - b.path.split("/").length ||
        Number(normalizedPath(b.path).endsWith(wanted)) -
          Number(normalizedPath(a.path).endsWith(wanted)) ||
        (embed
          ? Number(folder(b) === attachmentFolder) - Number(folder(a) === attachmentFolder)
          : 0) ||
        codePointOrder(a.path, b.path) ||
        codePointOrder(a.id, b.id),
    );
    if (byName.length)
      return { target: byName[0], candidates: byName, alias: false, existing: false };
    const aliases = pool
      .filter((candidate) =>
        candidate.aliases.some(
          (alias) => alias.toLowerCase() === decodedPath(linkpath).toLowerCase(),
        ),
      )
      .sort((a, b) => codePointOrder(a.path, b.path));
    if (aliases.length)
      return { target: aliases[0], candidates: aliases, alias: true, existing: false };
    const segments = wanted.split("/");
    const name = segments.pop() ?? "";
    const located = existing.flatMap((candidate) => {
      const item = locate(candidate.rankingUri ?? candidate.uri, candidate.id);
      return item ? [item] : [];
    });
    const holder = locate(source.rankingUri ?? source.uri, source.id);
    const hit = rankWikilinkMatches(located, { name, folders: segments }, holder);
    const projectTarget = existing.find((candidate) => candidate.id === hit?.documentId);
    if (projectTarget)
      return {
        target: projectTarget,
        candidates: existing.filter((candidate) =>
          normalizedPath(candidate.uri.split("://")[1])
            .toLowerCase()
            .endsWith(wanted.toLowerCase()),
        ),
        alias: false,
        existing: true,
      };
    const projectAliases = existing.filter((candidate) =>
      candidate.aliases.some(
        (alias) => alias.toLowerCase() === decodedPath(linkpath).toLowerCase(),
      ),
    );
    // Rank alias matches at their own locations, with the alias replacing only the filename.
    const aliasHit = rankWikilinkMatches(
      projectAliases.flatMap((candidate) => {
        const item = locate(candidate.rankingUri ?? candidate.uri, candidate.id);
        return item
          ? [{ ...item, segments: [...item.segments.slice(0, -1), name.toLowerCase()] }]
          : [];
      }),
      { name, folders: segments },
      holder,
    );
    const aliasTarget = projectAliases.find((candidate) => candidate.id === aliasHit?.documentId);
    return aliasTarget
      ? {
          target: aliasTarget,
          candidates: projectAliases,
          alias: true,
          existing: true,
        }
      : null;
  }
  function resolveMarkdown(path: string, source: ImportLinkCandidate) {
    const pool = selected.filter(
      (candidate) =>
        source.rootId === null || candidate.rootId === null || candidate.rootId === source.rootId,
    );
    const relative = normalizedPath([...source.path.split("/").slice(0, -1), path].join("/"));
    return (
      pool.find((candidate) => normalizedPath(candidate.path) === relative) ??
      pool.find((candidate) => normalizedPath(candidate.path) === normalizedPath(path)) ??
      null
    );
  }
  return { resolveLinkpath, resolveMarkdown };
}
export type ImportLinkIndex = ReturnType<typeof createLinkIndex>;
