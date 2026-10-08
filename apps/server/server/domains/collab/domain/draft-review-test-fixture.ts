/** Real-Yjs coverage for draft live-vs-draft hunk extraction and attribution. */
import { toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";

export const schema = buildDocumentSchema();
export const codec = mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver });
export const model = yProsemirrorModel(schema);

export function createDoc(markdown: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  const parsed = codec.parse(markdown);
  const root = schema.node("doc", null, parsed.blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  return doc;
}

export function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

export function captureUpdate(doc: Y.Doc, mutate: () => void): Uint8Array {
  const before = Y.encodeStateVector(doc);
  mutate();
  return Y.encodeStateAsUpdate(doc, before);
}

export function spanTextRange(
  doc: Y.Doc,
  span: { anchorFrom: string; anchorTo: string },
): { from: number; to: number } {
  const from = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(Buffer.from(span.anchorFrom, "base64")),
    doc,
  );
  const to = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(Buffer.from(span.anchorTo, "base64")),
    doc,
  );
  if (!from || !to || from.type !== to.type) throw new Error("expected span in one text node");
  return { from: from.index, to: to.index };
}
