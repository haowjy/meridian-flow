/** MDX syntax with HTML void-element closure at the JSX token boundary. */

import type { Extension } from "mdast-util-from-markdown";
import remarkMdx from "remark-mdx";
import type { Processor } from "unified";
import { VOID_ELEMENTS } from "../markdown/html-tag.js";

export function remarkMdxWithHtmlVoidElements(this: Processor): void {
  remarkMdx.call(this);
  const extend = (extension: Extension | Extension[]): void => {
    if (Array.isArray(extension)) {
      extension.forEach(extend);
      return;
    }
    const exits = extension.exit;
    if (!exits) return;
    for (const token of ["mdxJsxFlowTag", "mdxJsxTextTag"] as const) {
      const exit = exits[token];
      if (!exit) continue;
      exits[token] = function (token) {
        // remark-mdx has already validated and decoded the tag. Only HTML's
        // lowercase void names close implicitly; component names remain JSX.
        // The tag is established by remark-mdx’s matching enter handler.
        const tag = this.data.mdxJsxTag as NonNullable<typeof this.data.mdxJsxTag>;
        if (!tag.close && tag.name && VOID_ELEMENTS.has(tag.name)) tag.selfClosing = true;
        exit.call(this, token);
      };
    }
  };
  this.data().fromMarkdownExtensions?.forEach(extend);
}
