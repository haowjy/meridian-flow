/**
 * A room's text as a ProseMirror document, kept current as the room changes: one retained copy
 * per Y.Doc, so every reader shares its nodes instead of converting again.
 */
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Schema } from "@tiptap/pm/model";
import { initProseMirrorDoc, refreshProseMirrorDoc } from "@tiptap/y-tiptap";
import type * as Y from "yjs";

let schema: ReturnType<typeof buildDocumentSchema> | null = null;
const roomSchema = () => (schema ??= buildDocumentSchema());

const roomContents = new WeakMap<Y.Doc, ReturnType<typeof initProseMirrorDoc>>();
export function roomContent(doc: Y.Doc) {
  let content = roomContents.get(doc);
  if (!content) {
    const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    const retained = retainFragment(fragment, roomSchema());
    roomContents.set(doc, retained);
    doc.once("destroy", () => roomContents.delete(doc));
    content = retained;
  }
  return content;
}

function retainFragment(fragment: Y.XmlFragment, schema: Schema) {
  const retained = initProseMirrorDoc(fragment, schema);
  const refresh = (_events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    retained.doc = refreshProseMirrorDoc(
      fragment,
      retained.doc.type.schema,
      retained.meta,
      transaction,
    ).doc;
  };
  const dispose = () => {
    fragment.unobserveDeep(refresh);
    fragment.doc?.off("destroy", dispose);
  };
  fragment.observeDeep(refresh);
  fragment.doc?.on("destroy", dispose);
  return Object.assign(retained, { dispose });
}
