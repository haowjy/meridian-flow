/**
 * What choosing a row in the Editor's `@` menu writes: a standard link labeled
 * with a name, naming its target (a document or a folder) by ref and spelled
 * with the target's full Context URI as it stands now. Every surface spells it for its reader from
 * there; the `href` is only where the link pointed when it was written.
 *
 * Both producers assign refs without parsing and without the network: a
 * catalog row knows its identity, and the link-ahead row mints an ahead ref for
 * its address.
 */

import {
  aheadAddress,
  documentRef,
  type FolderId,
  folderRef,
  type LinkRef,
  mintAheadRef,
  storedHref,
} from "@meridian/contracts";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";

export type DocumentLinkRange = { from: number; to: number };

/** The canonical Editor node for an identity-bearing document reference. */
export function documentReferenceNode(
  schema: Schema,
  document: { label: string; documentId: string; uri: string },
): PMNode | null {
  return referenceLinkNode(schema, {
    label: document.label,
    ref: documentRef(document.documentId),
    href: storedHref({ kind: "document", uri: document.uri }, ""),
  });
}

/** The canonical Editor node for an identity-bearing folder reference. */
export function folderReferenceNode(
  schema: Schema,
  folder: { label: string; folderId: FolderId; uri: string },
): PMNode | null {
  return referenceLinkNode(schema, {
    label: folder.label,
    ref: folderRef(folder.folderId),
    href: storedHref({ kind: "folder", uri: folder.uri }, ""),
  });
}

/**
 * The link-ahead row: a link, never a document. Its ahead ref is minted here
 * for exactly this address; the chip is dashed until a document arrives there
 * (a follow's Create, an upload, a move), which settles the ref on it. The
 * link itself never changes.
 */
export function insertLinkAhead(
  editor: Editor,
  range: DocumentLinkRange,
  row: { label: string; uri: string },
): boolean {
  const address = aheadAddress(row.uri, "link");
  if (!address) return false;
  const node = referenceLinkNode(editor.schema, {
    label: row.label,
    ref: mintAheadRef(),
    href: storedHref({ kind: "document", uri: address }, ""),
  });
  return node ? insertDocumentLink(editor, range, node) : false;
}

function referenceLinkNode(
  schema: Schema,
  link: { label: string; ref: LinkRef; href: string },
): PMNode | null {
  const mark = schema.marks.link;
  if (!mark || !link.label) return null;
  return schema.text(link.label, [mark.create({ href: link.href, title: null, ref: link.ref })]);
}

function insertDocumentLink(editor: Editor, range: DocumentLinkRange, link: PMNode): boolean {
  if (!editor.isEditable) return false;
  return (
    editor
      .chain()
      .focus()
      .insertContentAt(range, link)
      // The link mark is non-inclusive, so the sentence continues unlinked; this
      // clears what the insertion left in the stored marks so the very next
      // keystroke agrees with that.
      .unsetMark("link")
      .run()
  );
}
