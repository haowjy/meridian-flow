/** A model's drafted write for tests: block `index` of `doc` rewritten in `draft`'s view as the model's own write. */

import type { Author } from "@meridian/suggestions";
import type { Schema } from "prosemirror-model";
import type * as Y from "yjs";
import { toDocHandle } from "../handles.js";
import { suggestingModel } from "../model/suggesting-model.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { lowerBlock } from "../resolver/lower-block.js";

export function suggestRewrite(
  doc: Y.Doc,
  schema: Schema,
  draft: string,
  author: Author,
  index: number,
  rewrite: (text: string) => string,
): void {
  const model = suggestingModel(yProsemirrorModel(schema), { draft }, author);
  const handle = toDocHandle(doc);
  doc.transact(() => {
    const shown = model.projectBlocks(handle)[index];
    const block = model.getBlocks(handle)[index];
    if (!shown || !block) return;
    const text = rewrite(shown.node.textContent);
    const next = shown.node.type.create(shown.node.attrs, text ? schema.text(text) : null);
    model.applyOps(handle, block, lowerBlock(shown.node, next));
  });
}
