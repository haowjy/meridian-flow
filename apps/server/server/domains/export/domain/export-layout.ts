import {
  CONTEXT_URI_SCHEME_NAMES,
  DEFAULT_EXPORT_AREA_NAMES,
  type ProjectExportOptions,
} from "@meridian/contracts";
import { numberedName, readSegment } from "@meridian/contracts/protocol";
import { exportFilename } from "../../context/index.js";
import type { ExportDocument, ExportFolder, ExportSourceRoot } from "../ports/export-snapshot.js";
export function portableName(name: string): string {
  const nfc = name.normalize("NFC");
  // slop-lint: allow suppression the control range is the point of the pattern
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ZIP names must exclude filesystem control bytes.
  const safe = nfc.replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "");
  return !safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe;
}
type Entry = { name: string; kind: "file" | "folder"; children: string[] };
export function buildExportLayout(
  documents: readonly ExportDocument[],
  options: ProjectExportOptions,
  sources: readonly ExportSourceRoot[] = [],
  folders: readonly ExportFolder[] = [],
): { paths: Map<string, string>; roots: Map<string, string>; emptyFolders: string[] } {
  const entries = new Map<string, Entry>([["", { name: "", kind: "folder", children: [] }]]);
  function add(key: string, parent: string, name: string, kind: Entry["kind"]): string {
    if (!entries.has(key)) {
      entries.set(key, { name: portableName(name), kind, children: [] });
      entries.get(parent)?.children.push(key);
    }
    return key;
  }
  function rootFor(source: ExportSourceRoot): string | null {
    let parent: string;
    if (source.scheme === "scratch" || source.scheme === "uploads") {
      if (!options[source.scheme]) return null;
      const works = add("works", "", "Works", "folder");
      const work = source.workId
        ? add(`work:${source.workId}`, works, source.workName ?? "Work", "folder")
        : add("no-work", works, "No Work", "folder");
      parent = add(
        `${work}:${source.scheme}`,
        work,
        CONTEXT_URI_SCHEME_NAMES[source.scheme],
        "folder",
      );
      if (source.scheme === "scratch" && !source.workId)
        parent = add(
          `chat:${source.rootThreadId}`,
          parent,
          source.chatTitle || "Untitled chat",
          "folder",
        );
    } else {
      const area = DEFAULT_EXPORT_AREA_NAMES[source.scheme as "kb"];
      if (!area) return null;
      parent = add(`area:${source.scheme}`, "", area, "folder");
    }
    return parent;
  }
  const rootKeys = new Map<string, string>();
  for (const source of [...sources].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))) {
    const root = rootFor(source);
    if (root) rootKeys.set(source.uri, root);
  }
  function folderOf(entry: ExportFolder, segments: readonly string[]): string | null {
    let parent = rootFor(entry);
    if (!parent) return null;
    rootKeys.set(entry.uri.slice(0, -entry.path.length), parent);
    let key = `${entry.scheme}:${entry.workId}:${entry.rootThreadId}`;
    for (const segment of segments) {
      key += `/${segment}`;
      parent = add(key, parent, readSegment(segment).name, "folder");
    }
    return parent;
  }
  for (const folder of folders) folderOf(folder, folder.path.split("/"));
  for (const doc of documents) {
    const parent = folderOf(doc, doc.path.split("/").slice(0, -1));
    if (parent)
      add(`doc:${doc.id}`, parent, exportFilename(doc.name, doc.extension, doc.fileType), "file");
  }
  const pathOf = new Map<string, string>([["", ""]]);
  for (const [key, { children }] of entries) {
    const parent = pathOf.get(key) as string;
    const taken = new Set<string>();
    const claim = (name: string) => {
      const clash = name.toLocaleLowerCase("en-US").normalize("NFC");
      return !taken.has(clash) && Boolean(taken.add(clash));
    };
    const own = children.map((child) => {
      const { name } = entries.get(child) as Entry;
      return claim(name) ? name : null;
    });
    children.forEach((child, index) => {
      const { name, kind } = entries.get(child) as Entry;
      let filename = own[index];
      for (let n = 2; !filename; n++)
        if (claim(numberedName(name, n, kind))) filename = numberedName(name, n, kind);
      pathOf.set(child, parent ? `${parent}/${filename}` : filename);
    });
  }
  const paths = new Map(
    documents.flatMap((doc) => {
      const path = pathOf.get(`doc:${doc.id}`);
      return path ? [[doc.id, path] as const] : [];
    }),
  );
  const roots = new Map([...rootKeys].map(([uri, key]) => [uri, pathOf.get(key) as string]));
  const emptyFolders = [...entries].flatMap(([key, { kind, children }]) =>
    key && kind === "folder" && children.length === 0 ? [pathOf.get(key) as string] : [],
  );
  return { paths, roots, emptyFolders };
}
