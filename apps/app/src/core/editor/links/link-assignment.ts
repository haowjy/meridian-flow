/**
 * The ref a link the writer puts in a document is assigned: the document it
 * names (`doc:`), an address nothing is at yet (`ahead:`), or none (an external
 * or contextual link, kept as written).
 *
 * Every client producer that turns written text into a link comes through
 * here (Ctrl+K and the link form, a Markdown or HTML paste, a rich paste from
 * another project), and here goes through markup's `assignFreshLink`, the pass
 * 3 agent-edit assigns with, so there is one answer to "which document did the
 * writer mean". It is synchronous and reads only the editor's local document
 * index: assignment never waits on the network. An internal address the index
 * has no document at gets an ahead ref, which settles on whatever document
 * arrives there first; an index that is incomplete or missing is therefore
 * safe, since an ahead ref minted for an occupied address settles on its
 * occupant.
 *
 * The `@` menu and `[[…]]` paste know their document's id already and write
 * `doc:` directly; they never parse a path to find it.
 */

import {
  type LinkRef,
  matchDocumentPath,
  parseContextUri,
  resolveDocumentHref,
  storedLinkRef,
} from "@meridian/contracts";
import { assignFreshLink } from "@meridian/markup";
import { Fragment, type Mark, type Node as PMNode, Slice } from "@tiptap/pm/model";

/** One document the editor's local index knows, by id and current address. */
export type LinkAssignmentDocument = { documentId: string; uri: string };

/** The editor's local document index, as assignment reads it. */
export type LinkAssignmentIndex = { readonly documents: readonly LinkAssignmentDocument[] };

/** Everything an assignment is relative to: the holder's address, its project, its index. */
export type LinkAssignmentScope = {
  holderUri: string | null;
  projectId: string | null;
  index: LinkAssignmentIndex | null;
};

/** What a link mark stores: a ref beside the href it is spelled with. */
export type AssignedLink = { ref: LinkRef | null; href: string };

/**
 * Assign one written href. Contextual and external links keep `ref: null`
 * and the href as written. An internal one is spelled as its canonical
 * absolute address (plus any `#`/`?` suffix) and gets the indexed document's
 * ref, or a fresh ahead ref when the index has none there.
 */
export function assignWrittenHref(
  href: string,
  holderUri: string | null,
  index: LinkAssignmentIndex | null,
): AssignedLink {
  const assigned = assignFreshLink({
    href,
    grammar: "link",
    holderUri,
    documentFor: (uri) => (index ? indexedDocumentAt(index.documents, uri) : null),
  });
  return assigned.kind === "literal"
    ? { ref: null, href }
    : { ref: assigned.ref, href: assigned.href };
}

/**
 * The indexed document at an internal address, by the server's address rule
 * (`matchDocumentPath`: the exact path, else the one path that differs only by
 * an omitted extension). A contextual address means the scope's own Work,
 * which is the only Work whose Scratch and Uploads the index holds.
 */
export function indexedDocumentAt<T extends LinkAssignmentDocument>(
  documents: readonly T[],
  uri: string,
): T | null {
  const requested = parseContextUri(uri);
  if (!requested.ok) return null;
  const { scheme, path, authority } = requested.value;
  const candidates = documents.flatMap((document) => {
    const candidate = parseContextUri(document.uri);
    if (!candidate.ok || candidate.value.scheme !== scheme) return [];
    if (
      authority.kind !== "contextual" &&
      JSON.stringify(candidate.value.authority) !== JSON.stringify(authority)
    )
      return [];
    return [{ document, path: candidate.value.path }];
  });
  return matchDocumentPath(candidates, path, (candidate) => candidate.path)?.document ?? null;
}

/**
 * The indexed document at exactly an ahead ref's stored address (design rule
 * 4: exact address, never the extension-omitted match), or null.
 */
export function indexedDocumentAtExactly<T extends LinkAssignmentDocument>(
  documents: readonly T[],
  href: string,
): T | null {
  const stored = resolveDocumentHref(href, null);
  if (!stored) return null;
  return documents.find((document) => document.uri === stored.uri) ?? null;
}

/**
 * Pasted nodes with every ref-less link assigned (the client's pass 3). A
 * link that already carries a ref came from a same-project rich paste or a
 * producer that knew its document, and keeps it. Images and figures keep
 * their sources: uploads carry `asset:` and nothing on the client mints a
 * source ref. Each distinct written href is assigned once per paste, so one
 * address pasted twice shares an assignment.
 *
 * A mark walk rather than `walkLinkOccurrences`: a pasted slice can hold bare
 * inline text at its top level, which the block walk does not visit, and an
 * assignment is a function of the mark alone, so runs need not be found.
 */
export function assignPastedNodes(
  nodes: readonly PMNode[],
  holderUri: string | null,
  index: LinkAssignmentIndex | null,
): readonly PMNode[] {
  const assignments = new Map<string, AssignedLink>();
  let changed = false;
  const assign = (mark: Mark): Mark => {
    if (mark.type.name !== "link" || storedLinkRef(mark.attrs.ref) !== null) return mark;
    const href = String(mark.attrs.href ?? "");
    let assigned = assignments.get(href);
    if (!assigned) {
      assigned = assignWrittenHref(href, holderUri, index);
      assignments.set(href, assigned);
    }
    if (assigned.ref === null && assigned.href === href) return mark;
    changed = true;
    return mark.type.create({ ...mark.attrs, ...assigned });
  };
  const mapNode = (node: PMNode): PMNode => {
    if (node.isText) return node.mark(node.marks.map(assign));
    const children: PMNode[] = [];
    node.content.forEach((child) => {
      children.push(mapNode(child));
    });
    return node.copy(Fragment.fromArray(children));
  };
  const mapped = nodes.map(mapNode);
  return changed ? mapped : nodes;
}

/** `assignPastedNodes` over a pasted slice, keeping its open depths. */
export function assignPastedSlice(slice: Slice, scope: LinkAssignmentScope): Slice {
  const nodes: PMNode[] = [];
  slice.content.forEach((node) => {
    nodes.push(node);
  });
  const assigned = assignPastedNodes(nodes, scope.holderUri, scope.index);
  return assigned === nodes
    ? slice
    : new Slice(Fragment.fromArray([...assigned]), slice.openStart, slice.openEnd);
}
