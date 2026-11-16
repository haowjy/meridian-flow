/**
 * What the screens read of a project's tree: the replay of its list (`@meridian/project-tree`),
 * cut to one source and shaped as rows with paths and addresses. Placement is read from the
 * replay everywhere, so a rename, a move or a delete shows in the tree, the tabs, the identity
 * bar and the pickers at once.
 */
import { type CanonicalContextAuthority, canonicalContextUri } from "@meridian/contracts";
import {
  type ContextSource,
  canonicalLeaf,
  childAtSegment,
  classifyFiletype,
  type DocumentFileType,
  documentFileTypeFor,
  type Filetype,
  type ProjectContextTreeScheme,
  readSegment,
  type YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import {
  isSourceRoot,
  pathOf,
  sourceIdOf,
  sourceRoot,
  type TreeNode,
  type TreeProjection,
} from "@meridian/project-tree";

/** A place in a tree: a restore's or a move's destination. */
export type TreeDestination = Readonly<{
  /** A folder's id, or the id of a source (the top of its tree). */
  parentId: string;
  /** Where among the siblings, when the writer chose a place. */
  index?: number;
}>;

type TreeFileBase = {
  kind: "file";
  entryId: string;
  parentId: string;
  documentId: string;
  name: string;
  /** The stored extension, which `name`'s suffix cannot tell from part of the name (`Vol. 2`). */
  extension: string;
  aliases?: readonly string[];
  /** A later twin's `~` suffix, when another entry here shares the name (its path segment's end). */
  suffix?: string;
  path: string;
  uri: string;
  /** The name was given, not chosen ("Untitled"); it ends at the first rename by a person. */
  provisionalName: boolean;
  /** The document has imported properties to show; they load by document id. */
  hasProperties: boolean;
};

export type TreeFile =
  | (TreeFileBase & { editable: true; filetype: Filetype; schemaType: YjsTrackedSchemaType })
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
  /** As a file's. */
  suffix?: string;
  path: string;
  uri: string;
};

export type TreeEntry = TreeDirectory | TreeFile;

/** One source's tree as the replay shows it. */
export type TreeView = {
  /** The top of the source. Its `entryId` is the source's id. */
  root: TreeDirectory;
  children(parentId: string): readonly TreeEntry[];
  files(): readonly TreeFile[];
  findPath(path: string): TreeFile | TreeDirectory | null;
  /**
   * The folder a path names, every segment read at folder level as a link and the server read
   * it: `/Kael` is the folder `Kael~dc40` when the plain `Kael` is a document. `/` is the root.
   */
  findFolder(path: string): TreeDirectory | null;
  findDocument(documentId: string): TreeFile | null;
  /** A folder or file of this source, shown (not in Trash). */
  entry(id: string): TreeEntry | null;
  /** The ids of the folders and files below `id`. */
  descendants(id: string): readonly string[];
};

/** The `~id` that ends a path's last segment: a twin's, which its name doesn't carry (`EntryName`). */
export function twinSuffix(path: string): string | undefined {
  const leaf = path.split("/").at(-1);
  return leaf ? readSegment(leaf).suffix : undefined;
}

const ROOT_NAMES: Record<ProjectContextTreeScheme, string> = {
  manuscript: "Manuscript",
  kb: "Knowledge",
  user: "User Files",
  unfiled: "Unfiled",
  scratch: "Scratch",
  uploads: "Uploads",
  agents: ".agents",
};

function extensionOf(node: TreeNode): string {
  if (node.kind === "folder") return "";
  const dot = node.name.lastIndexOf(".");
  return dot > 0 ? node.name.slice(dot + 1).toLowerCase() : "";
}

/** The shown node's classification, from its `create`'s type (a document) or its blob (a file). */
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
  // A type this build does not know (a newer client's): shown as a file it cannot open.
  return {
    editable: false as const,
    disposition: "binary" as const,
    fileType: "binary" as const,
  };
}

/**
 * The tree of one source. The replay's order is the sidebar's order (rank, then id); a node in Trash is not shown.
 */
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
    name: ROOT_NAMES[scheme],
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
            extension: extensionOf(node),
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
  // Walked by segment, so a twin's `~id` keeps reaching it after the plain twin is renamed.
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
      // A folder answers only to its own name; a document also to its alias (`ch1.md` is `ch1`).
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
