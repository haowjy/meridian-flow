import type { MarkCodec } from "../../types.js";

/**
 * Suggestion marks as CriticMarkup. Readers read a view with no suggestions in it, so these
 * spell only a document read raw. Markdown never parses back into a suggestion.
 */
function critic(name: string, open: string, close: string): MarkCodec {
  return { name, serialize: (text) => `${open}${text}${close}`, parse: () => null };
}

export const suggestionMarkCodecs: readonly MarkCodec[] = [
  critic("insertion", "{++", "++}"),
  critic("deletion", "{--", "--}"),
  critic("modification", "", ""),
  critic("blockBoundarySuggestion", "", ""),
];
