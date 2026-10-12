/** Pure selection-first Obsidian resolution and the shared project fallback ranking. */
import type { ImportManifest, ImportSettingsProblem } from "@meridian/contracts";
import {
  type Located,
  locate,
  rankWikilinkMatches,
  storedName,
  wantedPath,
  wikilinkMatches,
} from "@meridian/markup/obsidian";
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
/**
 * A Markdown link destination is a URL: percent-encoding is its syntax, so it is
 * decoded once here. Wikilink targets and file paths are literal and never pass through.
 */
export function decodedDestination(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
/** A literal selection path with `.`/`..` folded and the stored name of its file. */
export function normalizedPath(value: string): string {
  const parts: string[] = [];
  for (const segment of value.replace(/^\//, "").split("/")) {
    if (segment === "." || !segment) continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  if (parts.length) parts[parts.length - 1] = storedName(parts.at(-1) ?? "");
  return parts.join("/");
}
/**
 * A folder root's Obsidian settings, or the defaults with why: the browser sent
 * none it could read (`appJsonUnread`), or what it sent is not a JSON object.
 */
export function obsidianSettings(root: ImportManifest["roots"][number] | undefined): {
  attachmentFolderPath: string;
  newFileLocation: string;
  newFileFolderPath: string;
  problem: ImportSettingsProblem | null;
} {
  const defaults = { attachmentFolderPath: "", newFileLocation: "root", newFileFolderPath: "" };
  if (root?.appJson === undefined) return { ...defaults, problem: root?.appJsonUnread ?? null };
  let value: unknown;
  try {
    value = JSON.parse(root.appJson);
  } catch {
    return { ...defaults, problem: "malformed" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ...defaults, problem: "malformed" };
  const read = (key: string, fallback: string) => {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : fallback;
  };
  return {
    attachmentFolderPath: read("attachmentFolderPath", ""),
    newFileLocation: read("newFileLocation", "root"),
    newFileFolderPath: read("newFileFolderPath", ""),
    problem: null,
  };
}
export interface ImportLinkMatch {
  target: ImportLinkCandidate;
  /** Every candidate the ranking chose among; more than one is reported ambiguous. */
  candidates: ImportLinkCandidate[];
  alias: boolean;
  existing: boolean;
}
interface Indexed {
  candidate: ImportLinkCandidate;
  normalized: string;
  lower: string;
  folder: string;
  depth: number;
}
function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}
const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/**
 * Resolution over buckets built once: lookups touch only same-named, same-path or
 * same-alias candidates, so a link-dense note never rescans the whole selection.
 */
export function createLinkIndex(
  selected: readonly ImportLinkCandidate[],
  existing: readonly ImportLinkCandidate[],
) {
  const exact = new Map<string, Indexed[]>();
  const byBasename = new Map<string, Indexed[]>();
  const byAlias = new Map<string, ImportLinkCandidate[]>();
  for (const candidate of selected) {
    const normalized = normalizedPath(candidate.path);
    const lower = normalized.toLowerCase();
    const item: Indexed = {
      candidate,
      normalized,
      lower,
      folder: normalized.split("/").slice(0, -1).join("/"),
      depth: candidate.path.split("/").length,
    };
    push(exact, normalized, item);
    push(byBasename, lastSegment(lower), item);
    for (const alias of new Set(candidate.aliases.map((alias) => alias.toLowerCase())))
      push(byAlias, alias, candidate);
  }
  const existingById = new Map(existing.map((candidate) => [candidate.id, candidate]));
  const located = new Map<string, Located[]>();
  const existingAliases = new Map<string, ImportLinkCandidate[]>();
  for (const candidate of existing) {
    const item = locate(candidate.rankingUri ?? candidate.uri, candidate.id);
    if (item) push(located, item.segments.at(-1) ?? "", item);
    for (const alias of new Set(candidate.aliases.map((alias) => alias.toLowerCase())))
      push(existingAliases, alias, candidate);
  }
  const memo = new Map<string, ImportLinkMatch | null>();
  const inPool = (source: ImportLinkCandidate, candidate: ImportLinkCandidate) =>
    source.rootId === null || candidate.rootId === null || candidate.rootId === source.rootId;

  function resolveLinkpath(
    linkpath: string,
    source: ImportLinkCandidate,
    attachmentFolder = "",
    embed = false,
  ): ImportLinkMatch | null {
    const key = JSON.stringify([linkpath, source.id, attachmentFolder, embed]);
    if (memo.has(key)) return memo.get(key) ?? null;
    const result = resolveUncached(linkpath, source, attachmentFolder, embed);
    memo.set(key, result);
    return result;
  }
  function resolveUncached(
    linkpath: string,
    source: ImportLinkCandidate,
    attachmentFolder: string,
    embed: boolean,
  ): ImportLinkMatch | null {
    const wanted = normalizedPath(linkpath);
    const wantedLower = wanted.toLowerCase();
    const exactHits = (exact.get(wanted) ?? []).filter((item) => inPool(source, item.candidate));
    const names = exactHits.length
      ? exactHits
      : (byBasename.get(lastSegment(wantedLower)) ?? []).filter(
          (item) =>
            inPool(source, item.candidate) &&
            (item.lower === wantedLower || item.lower.endsWith(`/${wantedLower}`)),
        );
    const directory = normalizedPath(source.path).split("/").slice(0, -1).join("/");
    const byName = [...names].sort(
      (a, b) =>
        Number(b.folder === directory) - Number(a.folder === directory) ||
        a.depth - b.depth ||
        Number(b.normalized.endsWith(wanted)) - Number(a.normalized.endsWith(wanted)) ||
        (embed
          ? Number(b.folder === attachmentFolder) - Number(a.folder === attachmentFolder)
          : 0) ||
        codePointOrder(a.candidate.path, b.candidate.path) ||
        codePointOrder(a.candidate.id, b.candidate.id),
    );
    if (byName.length)
      return {
        target: byName[0].candidate,
        candidates: byName.map((item) => item.candidate),
        alias: false,
        existing: false,
      };
    const spelled = linkpath.toLowerCase();
    const aliases = (byAlias.get(spelled) ?? [])
      .filter((candidate) => inPool(source, candidate))
      .sort((a, b) => codePointOrder(a.path, b.path));
    if (aliases.length)
      return { target: aliases[0], candidates: aliases, alias: true, existing: false };
    const segments = wanted.split("/");
    const name = segments.pop() ?? "";
    const target = { name, folders: segments };
    const holder = locate(source.rankingUri ?? source.uri, source.id);
    // Candidates outside the stored-name bucket cannot end with the wanted path.
    const bucket = located.get(wantedPath(target).at(-1) ?? "") ?? [];
    const hit = rankWikilinkMatches(bucket, target, holder);
    const projectTarget = hit?.documentId ? existingById.get(hit.documentId) : undefined;
    if (projectTarget)
      return {
        target: projectTarget,
        candidates: wikilinkMatches(bucket, target).flatMap((item) => {
          const candidate = item.documentId ? existingById.get(item.documentId) : undefined;
          return candidate ? [candidate] : [];
        }),
        alias: false,
        existing: true,
      };
    const projectAliases = existingAliases.get(spelled) ?? [];
    // Rank alias matches at their own locations, with the alias replacing only the filename.
    const aliasHit = rankWikilinkMatches(
      projectAliases.flatMap((candidate) => {
        const item = locate(candidate.rankingUri ?? candidate.uri, candidate.id);
        return item
          ? [{ ...item, segments: [...item.segments.slice(0, -1), name.toLowerCase()] }]
          : [];
      }),
      target,
      holder,
    );
    const aliasTarget = projectAliases.find((candidate) => candidate.id === aliasHit?.documentId);
    return aliasTarget
      ? { target: aliasTarget, candidates: projectAliases, alias: true, existing: true }
      : null;
  }
  /** `path` is an already decoded Markdown destination. */
  function resolveMarkdown(path: string, source: ImportLinkCandidate) {
    const first = (normalized: string) =>
      (exact.get(normalized) ?? []).find((item) => inPool(source, item.candidate))?.candidate;
    const relative = normalizedPath([...source.path.split("/").slice(0, -1), path].join("/"));
    return first(relative) ?? first(normalizedPath(path)) ?? null;
  }
  return { resolveLinkpath, resolveMarkdown };
}
export type ImportLinkIndex = ReturnType<typeof createLinkIndex>;
