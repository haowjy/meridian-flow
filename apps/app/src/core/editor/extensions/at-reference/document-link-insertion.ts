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
