import {
  CONTEXT_URI_SCHEME_NAMES,
  DEFAULT_EXPORT_AREA_NAMES,
  type ProjectExportOptions,
} from "@meridian/contracts";
import { numberedName, readSegment } from "@meridian/contracts/protocol";
import { exportFilename } from "../../context/index.js";
import type { ExportDocument, ExportSourceRoot } from "../ports/export-snapshot.js";
export function portableName(name: string): string {
  // slop-lint: allow suppression the control range is the point of the pattern
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
  function claim(parent: string, filename: string): string | null {
    const siblings = used.get(parent) ?? new Set<string>();
    used.set(parent, siblings);
    const key = filename.toLocaleLowerCase("en-US");
    if (siblings.has(key)) return null;
    siblings.add(key);
    return parent ? `${parent}/${filename}` : filename;
  }
  function reserve(parent: string, name: string, kind: "file" | "folder"): string {
    const portable = portableName(name);
    for (let n = 1; ; n++) {
      const path = claim(parent, numberedName(portable, n, kind));
      if (path) return path;
    }
  }
  function folder(key: string, parent: string, name: string): string {
    let path = folders.get(key);
    if (!path) {
      path = reserve(parent, name, "folder");
      folders.set(key, path);
    }
    return path;
  }
  folder("works", "", "Works");
  folder("no-work", "Works", "No Work");
  function rootFor(source: ExportSourceRoot): string | null {
    let parent: string;
    if (source.scheme === "scratch" || source.scheme === "uploads") {
      if (!options[source.scheme]) return null;
      const work = source.workId
        ? folder(`work:${source.workId}`, "Works", source.workName ?? "Work")
        : "Works/No Work";
      parent = folder(`${work}:${source.scheme}`, work, CONTEXT_URI_SCHEME_NAMES[source.scheme]);
      if (source.scheme === "scratch" && !source.workId)
        parent = folder(`chat:${source.rootThreadId}`, parent, source.chatTitle || "Untitled chat");
    } else {
      const area = DEFAULT_EXPORT_AREA_NAMES[source.scheme as "kb"];
      if (!area) return null;
      parent = folder(`area:${source.scheme}`, "", area);
    }
    return parent;
  }
  for (const source of [...sources].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))) {
    const root = rootFor(source);
    if (root) roots.set(source.uri, root);
  }
  const placed: { doc: ExportDocument; parent: string }[] = [];
  for (const doc of documents) {
    let parent = rootFor(doc);
    if (!parent) continue;
    roots.set(doc.uri.slice(0, -doc.path.length), parent);
    let key = `${doc.scheme}:${doc.workId}:${doc.rootThreadId}`;
    for (const segment of doc.path.split("/").slice(0, -1)) {
      key += `/${segment}`;
      parent = folder(key, parent, readSegment(segment).name);
    }
    placed.push({ doc, parent });
  }
  const named = placed.map(({ doc, parent }) => {
    const filename = portableName(exportFilename(doc.name, doc.extension, doc.fileType));
    return { doc, parent, filename, path: claim(parent, filename) };
  });
  for (const { doc, parent, filename, path } of named)
    paths.set(doc.id, path ?? reserve(parent, filename, "file"));
  return { paths, roots };
}
