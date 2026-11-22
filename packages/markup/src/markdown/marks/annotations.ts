import type { MarkCodec } from "../../types.js";

/** A comment anchor has no Markdown form: its text is written as itself, and nothing parses back into one. */
const comment: MarkCodec = { name: "comment", serialize: (text) => text, parse: () => null };

export const annotationMarkCodecs: readonly MarkCodec[] = [comment];
