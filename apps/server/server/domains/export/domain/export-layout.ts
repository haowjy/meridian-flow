/** Portable, case-insensitive ZIP paths with one reservation space for files and folders. */
import { DEFAULT_EXPORT_AREA_NAMES, type ProjectExportOptions } from "@meridian/contracts";
import type { ExportDocument, ExportSourceRoot } from "../ports/export-snapshot.js";
export function portableName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ZIP names must exclude filesystem control bytes.
  const safe = name.replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "");
  return !safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe;
}
export function buildExportLayout(
  documents: readonly ExportDocument[],
  options: ProjectExportOptions,
  sources: readonly ExportSourceRoot[] = [],
): { paths: Map<string, string>; roots: Map<string, string> } {
  const used = new Map<string, Set<string>>();
  const folders = new Map<string, string>();
  const paths = new Map<string, string>();
  const roots = new Map<string, string>();
  function reserve(parent: string, name: string, extension = ""): string {
    const siblings = used.get(parent) ?? new Set<string>();
    used.set(parent, siblings);
    const stem = portableName(name);
    for (let n = 1; ; n++) {
      const filename = `${stem}${n === 1 ? "" : ` (${n})`}${extension ? `.${extension}` : ""}`;
      if (!siblings.has(filename.toLocaleLowerCase("en-US"))) {
        siblings.add(filename.toLocaleLowerCase("en-US"));
        return parent ? `${parent}/${filename}` : filename;
      }
    }
  }
  function folder(key: string, parent: string, name: string): string {
    let path = folders.get(key);
    if (!path) {
      path = reserve(parent, name);
      folders.set(key, path);
    }
    return path;
  }
  // Reserve No Work even when empty so a named Work cannot steal its directory.
  folder("works", "", "Works");
  folder("no-work", "Works", "No Work");
  function rootFor(source: ExportSourceRoot): string | null {
    let parent: string;
    if (source.scheme === "scratch" || source.scheme === "uploads") {
      if (!options[source.scheme]) return null;
      const work = source.workId
        ? folder(`work:${source.workId}`, "Works", source.workName ?? "Work")
        : "Works/No Work";
      parent = folder(
        `${work}:${source.scheme}`,
        work,
        source.scheme === "scratch" ? "Scratch" : "Uploads",
      );
      if (source.scheme === "scratch" && !source.workId)
        parent = folder(`chat:${source.rootThreadId}`, parent, source.chatTitle || "Untitled chat");
    } else {
      const area = DEFAULT_EXPORT_AREA_NAMES[source.scheme as "kb"];
      if (!area) return null;
      parent = folder(`area:${source.scheme}`, "", area);
    }
    return parent;
  }
  for (const source of [...sources].sort((a, b) => a.uri.localeCompare(b.uri))) {
    const root = rootFor(source);
    if (root) roots.set(source.uri, root);
  }
  for (const doc of [...documents].sort((a, b) =>
    a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : a.id.localeCompare(b.id),
  )) {
    let parent = rootFor(doc);
    if (!parent) continue;
    roots.set(doc.uri.slice(0, -doc.path.length), parent);
    let key = `${doc.scheme}:${doc.workId}:${doc.rootThreadId}`;
    for (const segment of doc.path.split("/").slice(0, -1)) {
      key += `/${segment}`;
      parent = folder(key, parent, segment);
    }
    paths.set(
      doc.id,
      reserve(parent, doc.name, doc.fileType === "markdown" ? "md" : doc.extension),
    );
  }
  return { paths, roots };
}
