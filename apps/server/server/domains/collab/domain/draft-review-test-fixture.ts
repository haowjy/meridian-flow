/** Real-Yjs coverage for draft live-vs-draft hunk extraction and attribution. */
import { toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";

import type { IndexedDraftUpdate } from "./draft-review-operations.js";

export const schema = buildDocumentSchema();
export const codec = mdxCodec({ schema });
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

export type TextEditRow = Omit<IndexedDraftUpdate, "updateData"> & {
  clientId?: number;
  edits: readonly (readonly [block: number, from: number, to: number, text: string])[];
};

/** Explicit journal authors and edits over one real live/draft pair; no attribution oracle. */
export function createDraftReviewFixture(markdown: string, rows: readonly TextEditRow[] = []) {
  const live = createDoc(markdown);
  const draft = cloneDoc(live);
  const updates = rows.map(({ clientId, edits, ...author }) => {
    if (clientId !== undefined) draft.clientID = clientId;
    return {
      ...author,
      updateData: captureUpdate(draft, () => {
        for (const [index, from, to, text] of edits) {
          const block = model.getBlocks(toDocHandle(draft))[index];
          model.applyTextEdit(toDocHandle(draft), block, { from, to }, text);
        }
      }),
    };
  });
  return {
    live,
    draft,
    input: { liveDoc: live, draftDoc: draft, model, draftUpdates: updates },
    destroy() {
      draft.destroy();
      live.destroy();
    },
  };
}
