/** Positioned Markdown parser shared by codecs and source scanners. */

import type { Extension } from "mdast-util-from-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { type PluggableList, type Processor, unified } from "unified";

export function markdownParser(plugins: PluggableList = []) {
  return unified().use(remarkParse).use(positionedGfm).use(plugins);
}

/** Keep GFM token positions; its legacy text transform invents positionless links even from escaped URLs. */
function positionedGfm(this: Processor): void {
  remarkGfm.call(this);
  // Depends on remark-gfm's extension shape; the bare-prose round-trip row guards upgrades.
  const extensions = this.data().fromMarkdownExtensions ?? [];
  const removeLegacyAutolinks = (extension: Extension | Extension[]): void => {
    if (Array.isArray(extension)) {
      extension.forEach(removeLegacyAutolinks);
    } else if (extension.enter?.literalAutolink) {
      extension.transforms = [];
    }
  };
  extensions.forEach(removeLegacyAutolinks);
}
