import {
  type CanonicalContextAuthority,
  CONTEXT_URI_SCHEME_NAMES,
  canonicalContextUri,
} from "@meridian/contracts";
import {
  type ContextSiblingPosition,
  type ContextSource,
  canonicalLeaf,
  childAtSegment,
  classifyFiletype,
  type DocumentFileType,
  documentFileTypeFor,
  entryExtension,
  type Filetype,
  type ProjectContextTreeScheme,
  readSegment,
  type TrackedSchemaType,
} from "@meridian/contracts/protocol";
import {
  isSourceRoot,
  pathOf,
  sourceIdOf,
  sourceRoot,
  type TreeNode,
  type TreeProjection,
} from "@meridian/project-tree";

export type TreeDestination = Readonly<{
  parentId: string;
  position?: ContextSiblingPosition;
}>;

type TreeFileBase = {
  kind: "file";
  entryId: string;
  parentId: string;
  documentId: string;
  name: string;
  extension: string;
  aliases?: readonly string[];
  suffix?: string;
  path: string;
  uri: string;
  provisionalName: boolean;
  hasProperties: boolean;
};

export type TreeFile =
  | (TreeFileBase & { editable: true; filetype: Filetype; schemaType: TrackedSchemaType })
  | (TreeFileBase & {
      editable: false;
      disposition: "binary" | "custom";
      fileType: DocumentFileType;
      mimeType?: string;
      filetype?: Filetype;
    });

export type TreeDirectory = {
  kind: "dir";
  entryId: string;
  parentId: string | null;
  name: string;
  suffix?: string;
  path: string;
  uri: string;
};

export type TreeEntry = TreeDirectory | TreeFile;

export type TreeView = {
  root: TreeDirectory;
  children(parentId: string): readonly TreeEntry[];
  files(): readonly TreeFile[];
  findPath(path: string): TreeFile | TreeDirectory | null;
  findFolder(path: string): TreeDirectory | null;
  findDocument(documentId: string): TreeFile | null;
  entry(id: string): TreeEntry | null;
  descendants(id: string): readonly string[];
};

export function twinSuffix(path: string): string | undefined {
  const leaf = path.split("/").at(-1);
  return leaf ? readSegment(leaf).suffix : undefined;
}

function classification(node: TreeNode) {
  if (node.kind === "file") {
    const mimeType = node.blob?.mime ?? "application/octet-stream";
    return {
      editable: false as const,
      disposition: "binary" as const,
      fileType: documentFileTypeFor({ filetype: null, mimeType }) ?? ("binary" as const),
      mimeType,
    };
  }
  const classified = classifyFiletype(node.filetype);
  if (classified.kind === "tracked")
    return {
      editable: true as const,
      filetype: node.filetype as Filetype,
      schemaType: classified.schemaType,
    };
  if (classified.kind === "custom")
    return {
      editable: false as const,
      disposition: "custom" as const,
      fileType: classified.fileType,
      filetype: node.filetype as Filetype,
    };
  return {
    editable: false as const,
    disposition: "binary" as const,
    fileType: "binary" as const,
  };
}

export function buildTreeView(input: {
  projection: TreeProjection;
  scheme: ProjectContextTreeScheme;
  source: Pick<ContextSource, "id">;
  authority: CanonicalContextAuthority;
}): TreeView {
  const { projection, scheme, source, authority } = input;
  const sourceId = source.id;
  const uriOf = (path: string) => canonicalContextUri(scheme, path, authority);
  const root: TreeDirectory = {
    kind: "dir",
    entryId: sourceId,
    parentId: null,
    name: CONTEXT_URI_SCHEME_NAMES[scheme],
    path: "/",
    uri: uriOf(""),
  };

  const shown = (node: TreeNode | undefined): node is TreeNode =>
    node !== undefined && node.source === sourceId && !node.trashed && !node.purged;
  const parentIdOf = (node: TreeNode) =>
    isSourceRoot(node.parent) ? sourceIdOf(node.parent) : node.parent;

  const entryCache = new Map<string, TreeEntry>();
  const entryOf = (node: TreeNode): TreeEntry => {
    const cached = entryCache.get(node.id);
    if (cached) return cached;
    const path = pathOf(projection, node);
    const built: TreeEntry =
      node.kind === "folder"
        ? {
            kind: "dir",
            entryId: node.id,
            parentId: parentIdOf(node),
            name: node.name,
            ...(node.suffix ? { suffix: node.suffix } : {}),
            path,
            uri: uriOf(path),
          }
        : {
            kind: "file",
            entryId: node.id,
            parentId: parentIdOf(node),
            documentId: node.id,
            name: node.name,
            extension: entryExtension(node),
            ...(node.aliases ? { aliases: node.aliases } : {}),
            ...(node.suffix ? { suffix: node.suffix } : {}),
            path,
            uri: uriOf(path),
            provisionalName: node.provisional,
            hasProperties: node.hasProperties,
            ...classification(node),
          };
    entryCache.set(node.id, built);
    return built;
  };

  const childrenOfParent = (parentId: string): TreeNode[] =>
    (projection.children.get(parentId === sourceId ? sourceRoot(sourceId) : parentId) ?? []).filter(
      shown,
    );
  const folderAt = (segments: readonly string[]): string | null => {
    let at = sourceId;
    for (const segment of segments) {
      const folder = childAtSegment(childrenOfParent(at), segment, "folder");
      if (!folder) return null;
      at = folder.id;
    }
    return at;
  };
  const everyShown = (): TreeNode[] => [...projection.nodes.values()].filter(shown);

  const files = () =>
    everyShown().flatMap((node) => (node.kind === "folder" ? [] : [entryOf(node) as TreeFile]));
  const findDocument = (documentId: string) => {
    const node = projection.nodes.get(documentId);
    return shown(node) && node.kind !== "folder" ? (entryOf(node) as TreeFile) : null;
  };

  return {
    root,
    children: (parentId) => childrenOfParent(parentId).map(entryOf),
    files,
    entry: (id) => {
      const node = projection.nodes.get(id);
      return shown(node) ? entryOf(node) : null;
    },
    descendants: (id) => {
      const out: string[] = [];
      const walk = (parentId: string) => {
        for (const child of childrenOfParent(parentId)) {
          out.push(child.id);
          if (child.kind === "folder") walk(child.id);
        }
      };
      walk(id);
      return out;
    },
    findPath: (path) => {
      const segments = path.split("/").filter(Boolean);
      const leaf = segments.pop();
      if (leaf === undefined) return null;
      const parentId = folderAt(segments);
      if (parentId === null) return null;
      const kids = childrenOfParent(parentId);
      const alias = childAtSegment(kids, canonicalLeaf(leaf));
      const found = childAtSegment(kids, leaf) ?? (alias?.kind === "folder" ? undefined : alias);
      return found ? (entryOf(found) as TreeFile | TreeDirectory) : null;
    },
    findFolder: (path) => {
      const id = folderAt(path.split("/").filter(Boolean));
      const node = id === null ? undefined : projection.nodes.get(id);
      return id === sourceId ? root : node ? (entryOf(node) as TreeDirectory) : null;
    },
    findDocument,
  };
}
