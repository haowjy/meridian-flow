import {
  type LinkRef,
  matchOmittedExtension,
  parseContextUri,
  storedLinkRef,
} from "@meridian/contracts";
import { assignFreshLink } from "@meridian/markup/links";
import { Fragment, type Mark, type Node as PMNode, Slice } from "@tiptap/pm/model";
import type { TreeView } from "@/core/project-tree/tree-view";

export type LinkAssignmentDocument = { documentId: string; uri: string };

type LinkAssignmentFolder = { folderId: string; uri: string };

export type LinkAssignmentIndex = {
  readonly documents: readonly LinkAssignmentDocument[];
  readonly folders: readonly LinkAssignmentFolder[];
  readonly trees: readonly TreeView[];
};

export type LinkAssignmentScope = {
  holderUri: string | null;
  projectId: string | null;
  index: LinkAssignmentIndex | null;
};

export type AssignedLink = { ref: LinkRef | null; href: string };

export function assignWrittenHref(
  href: string,
  holderUri: string | null,
  index: LinkAssignmentIndex | null,
): AssignedLink {
  const assigned = assignFreshLink({
    href,
    grammar: "link",
    holderUri,
    documentFor: (uri) => (index ? indexedDocumentAt(index, uri) : null),
    folderFor: (uri) => (index ? indexedFolderAt(index, uri) : null),
  });
  if (assigned.kind === "literal") return { ref: null, href };
  if (assigned.kind === "folder-address") return { ref: null, href: assigned.href };
  return { ref: assigned.ref, href: assigned.href };
}

export function assignWrittenSource(src: string, index: LinkAssignmentIndex | null): AssignedLink {
  const assigned = assignFreshLink({
    href: src,
    grammar: "source",
    holderUri: null,
    documentFor: (uri) => (index ? indexedDocumentAt(index, uri) : null),
    folderFor: () => null,
  });
  if (assigned.kind === "literal") return { ref: null, href: src };
  if (assigned.kind === "folder-address") return { ref: null, href: assigned.href };
  return { ref: assigned.ref, href: assigned.href };
}

function treeAt(trees: readonly TreeView[], uri: string) {
  const requested = parseContextUri(uri);
  if (!requested.ok) return null;
  const { scheme, path, authority } = requested.value;
  const tree = trees.find((candidate) => {
    const root = parseContextUri(candidate.root.uri);
    return (
      root.ok &&
      root.value.scheme === scheme &&
      (authority.kind === "contextual" ||
        JSON.stringify(root.value.authority) === JSON.stringify(authority))
    );
  });
  return tree ? { tree, path } : null;
}

export function indexedDocumentAt<T extends LinkAssignmentDocument>(
  index: { documents: readonly T[]; trees: readonly TreeView[] },
  uri: string,
): T | null {
  const at = treeAt(index.trees, uri);
  if (!at) return null;
  const found = at.tree.findPath(at.path);
  let documentId = found?.kind === "file" ? found.documentId : undefined;
  if (documentId === undefined) {
    const slash = at.path.lastIndexOf("/");
    const folder = at.tree.findFolder(at.path.slice(0, Math.max(slash, 0)));
    const files = folder
      ? at.tree.children(folder.entryId).filter((entry) => entry.kind === "file")
      : [];
    documentId = matchOmittedExtension(files, at.path.slice(slash + 1), (entry) =>
      entry.path.slice(entry.path.lastIndexOf("/") + 1),
    )?.documentId;
  }
  return index.documents.find((document) => document.documentId === documentId) ?? null;
}

export function indexedFolderAt<T extends LinkAssignmentFolder>(
  index: { folders: readonly T[]; trees: readonly TreeView[] },
  uri: string,
): T | null {
  const at = treeAt(index.trees, uri);
  const folderId = at?.tree.findFolder(at.path)?.entryId;
  return index.folders.find((folder) => folder.folderId === folderId) ?? null;
}

/**
 * A pasted slice with every ref-less link and picture assigned (the client's
 * pass 3), each under its own grammar: a link mark's href against the holder
 * (`assignWrittenHref`), an `image`/`figure` source from the manuscript root
 * (`assignWrittenSource`). A link or picture that already carries a ref came
 * from a same-project rich paste or a producer that knew its document, and
 * keeps it; so does an `asset:` upload, which a same-project paste restores
 * (`link-clipboard.ts`). Each distinct written address is assigned once per
 * paste per grammar, so one address pasted twice shares an assignment.
 *
 * A node walk rather than `walkLinkOccurrences`: a pasted slice can hold bare
 * inline text at its top level, which the block walk does not visit, and an
 * assignment is a function of the mark or picture alone, so runs need not be
 * found.
 */
export function assignPastedSlice(slice: Slice, scope: LinkAssignmentScope): Slice {
  const { holderUri, index } = scope;
  const assignments = new Map<string, AssignedLink>();
  const assigned = (grammar: "link" | "source", written: string): AssignedLink => {
    const key = `${grammar}\u0000${written}`;
    let assignment = assignments.get(key);
    if (!assignment) {
      assignment =
        grammar === "link"
          ? assignWrittenHref(written, holderUri, index)
          : assignWrittenSource(written, index);
      assignments.set(key, assignment);
    }
    return assignment;
  };
  let changed = false;
  const assignMark = (mark: Mark): Mark => {
    if (mark.type.name !== "link" || storedLinkRef(mark.attrs.ref) !== null) return mark;
    const href = String(mark.attrs.href ?? "");
    const assignment = assigned("link", href);
    if (assignment.ref === null && assignment.href === href) return mark;
    changed = true;
    return mark.type.create({ ...mark.attrs, ...assignment });
  };
  const mapNode = (node: PMNode): PMNode => {
    if (node.isText) return node.mark(node.marks.map(assignMark));
    const marks = node.marks.map(assignMark);
    if (node.type.name === "image" || node.type.name === "figure") {
      const src = String(node.attrs.src ?? "");
      if (!src || src.startsWith("asset:") || storedLinkRef(node.attrs.ref) !== null)
        return node.mark(marks);
      const assignment = assigned("source", src);
      if (!assignment.ref) return node.mark(marks);
      changed = true;
      return node.type.create(
        { ...node.attrs, src: assignment.href, ref: assignment.ref },
        node.content,
        marks,
      );
    }
    const children: PMNode[] = [];
    node.content.forEach((child) => {
      children.push(mapNode(child));
    });
    return node.type.create(node.attrs, Fragment.fromArray(children), marks);
  };
  const nodes: PMNode[] = [];
  slice.content.forEach((node) => {
    nodes.push(mapNode(node));
  });
  return changed ? new Slice(Fragment.fromArray(nodes), slice.openStart, slice.openEnd) : slice;
}
