import type { MarkCodec } from "../../types.js";

/** A comment anchor has no Markdown form: its text is written as itself, and nothing parses back into one. */
const comment: MarkCodec = { name: "comment", serialize: (text) => text, parse: () => null };

/**
 * Every reader serializes a view, which has no suggestion: one that reaches here skipped the view
 * and would print pending text as Live, so it fails instead.
 */
function suggestion(name: string): MarkCodec {
  return {
    name,
    serialize: () => {
      throw new Error(`pm->mdast: "${name}" reached Markdown; read through a view`);
    },
    parse: () => null,
  };
}

export const annotationMarkCodecs: readonly MarkCodec[] = [
  comment,
  suggestion("suggest_ins"),
  suggestion("suggest_del"),
];
