import type { MarkCodec } from "../../types.js";

const comment: MarkCodec = { name: "comment", serialize: (text) => text, parse: () => null };

export const annotationMarkCodecs: readonly MarkCodec[] = [comment];
