/**
 * What the screens read of a project's tree: the replay of its list (`@meridian/project-tree`),
 * cut to one source and shaped as rows with paths and addresses. Placement is read from the
 * replay everywhere, so a rename, a move or a delete shows in the tree, the tabs, the identity
 * bar and the pickers at once.
 */
import {
  type CanonicalContextAuthority,
  canonicalContextUri,
  matchDocumentAddress,
} from "@meridian/contracts";
import {
  type ContextSource,
  classifyFiletype,
  type DocumentFileType,
  documentFileTypeFor,
  type Filetype,
  type ProjectContextTreeScheme,
  type YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import {
  isSourceRoot,
  sourceIdOf,
  sourceRoot,
  type TreeNode,
  type TreeProjection,
} from "@meridian/project-tree";

/** Where a refused record would have put a node: the writer's repair offers it again. */
export type TreeDestination = Readonly<{
  /** A folder's id, or the id of a source (the top of its tree). */
  parentId: string;
  /** Where among the siblings, when the writer chose a place. */
  index?: number;
}>;

/** What the server refused of the writer's own work, shown on the row it concerns. */
export type NamespaceFailure = "delete" | "set-location" | "create";

export type TreeFailure = {
  namespaceFailure: NamespaceFailure;
  /** The server's reason, in its own words. */
  failureReason?: string;
  /** The name the writer asked for, for a rename the server refused. */
  namespaceRepairName?: string;
  /** The place the writer asked for, for a move (or a create the server kept in Unfiled) it refused. */
  namespaceRepairMove?: TreeDestination;
  /** When this tab first saw the refusal; undefined for one already settled when the list loaded. */
  namespaceFailureAt?: number;
  /** The refused record, to dismiss. */
  failureRecord: string;
};

type TreeFileBase = {
  kind: "file";
  entryId: string;
  parentId: string;
  documentId: string;
  name: string;
  /** The stored extension, which `name`'s suffix cannot tell from part of the name (`Vol. 2`). */
  extension: string;
  aliases?: readonly string[];
  path: string;
  uri: string;
  /** The name was given, not chosen ("Untitled"); it ends at the first rename by a person. */
  provisionalName: boolean;
  /** The document has imported properties to show; they load by document id. */
  hasProperties: boolean;
} & Partial<TreeFailure>;

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
  path: string;
  uri: string;
} & Partial<TreeFailure>;

export type TreeEntry = TreeDirectory | TreeFile;

/** One source's tree as the replay shows it. */
export type TreeView = {
  /** The top of the source. Its `entryId` is the source's id. */
  root: TreeDirectory;
  children(parentId: string): readonly TreeEntry[];
  files(): readonly TreeFile[];
  findPath(path: string): TreeFile | TreeDirectory | null;
  findDocument(documentId: string): TreeFile | null;
  /** A folder or file of this source, shown (not in Trash). */
  entry(id: string): TreeEntry | null;
  /** The ids of the folders and files below `id`. */
  descendants(id: string): readonly string[];
};

const ROOT_NAMES: Record<ProjectContextTreeScheme, string> = {
  manuscript: "Manuscript",
  kb: "Knowledge",
  user: "User Files",
  unfiled: "Unfiled",
  scratch: "Scratch",
  uploads: "Uploads",
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
 * The tree of one source. `failures` are the refusals of the writer's own records, by node.
 * The replay's order is the sidebar's order (rank, then id); a node in Trash is not shown.
 */
export function buildTreeView(input: {
  projection: TreeProjection;
  scheme: ProjectContextTreeScheme;
  /** Null while the sources are not known: an empty tree with a placeholder root. */
  source: Pick<ContextSource, "id"> | null;
  authority: CanonicalContextAuthority;
  failures?: ReadonlyMap<string, TreeFailure>;
}): TreeView {
  const { projection, scheme, source, authority, failures } = input;
  const sourceId = source?.id ?? `missing:${scheme}`;
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
  const pathCache = new Map<string, string>();
  const pathOf = (node: TreeNode): string => {
    const cached = pathCache.get(node.id);
    if (cached !== undefined) return cached;
    const parent = isSourceRoot(node.parent) ? undefined : projection.nodes.get(node.parent);
    const path = `${parent ? pathOf(parent) : ""}/${node.displayName}`;
    pathCache.set(node.id, path);
    return path;
  };
  const parentIdOf = (node: TreeNode) =>
    isSourceRoot(node.parent) ? sourceIdOf(node.parent) : node.parent;

  const entryCache = new Map<string, TreeEntry>();
  const entryOf = (node: TreeNode): TreeEntry => {
    const cached = entryCache.get(node.id);
    if (cached) return cached;
    const path = pathOf(node);
    const failure = failures?.get(node.id);
    const built: TreeEntry =
      node.kind === "folder"
        ? {
            kind: "dir",
            entryId: node.id,
            parentId: parentIdOf(node),
            name: node.displayName,
            path,
            uri: uriOf(path),
            ...failure,
          }
        : {
            kind: "file",
            entryId: node.id,
            parentId: parentIdOf(node),
            documentId: node.id,
            name: node.displayName,
            extension: extensionOf(node),
            ...(node.aliases ? { aliases: node.aliases } : {}),
            path,
            uri: uriOf(path),
            provisionalName: node.provisional,
            hasProperties: node.hasProperties,
            ...classification(node),
            ...failure,
          };
    entryCache.set(node.id, built);
    return built;
  };

  const childrenOfParent = (parentId: string): TreeNode[] =>
    (projection.children.get(parentId === sourceId ? sourceRoot(sourceId) : parentId) ?? []).filter(
      shown,
    );
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
      const all = files();
      const literal =
        all.find((file) => file.path === path) ??
        everyShown()
          .filter((node) => node.kind === "folder" && pathOf(node) === path)
          .map(entryOf)[0];
      // A folder answers only to its own name; a document also to its alias (`ch1.md` is `ch1`).
      return literal
        ? (literal as TreeFile | TreeDirectory)
        : matchDocumentAddress(all, path, (file) => file.path);
    },
    findDocument,
  };
}
