import type { MarkCodec } from "../../types.js";

/**
 * Suggestions and comment anchors have no Markdown form: readers see a view with no suggestions
 * (`@meridian/suggestions` `viewOf`), and a comment's anchor is lost in Markdown. Their text is
 * written as itself and nothing parses back into one.
 */
function annotation(name: string): MarkCodec {
  return { name, serialize: (text) => text, parse: () => null };
}

export const annotationMarkCodecs: readonly MarkCodec[] = [
  annotation("suggest_ins"),
  annotation("suggest_del"),
  annotation("comment"),
];
