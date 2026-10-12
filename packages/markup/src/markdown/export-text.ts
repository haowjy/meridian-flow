/** Export preserves literal Obsidian-shaped spans, not other Markdown bracket syntax. */
import { defaultHandlers, type Handle } from "mdast-util-to-markdown";

export const exportText: Handle = (node, parent, state, info) => {
  const value = (node as { value: string }).value;
  const spans = [...value.matchAll(/!?\[\[([^[\]\r\n]+)\]\]/g)];
  if (!spans.length) return defaultHandlers.text(node, parent, state, info);
  let result = "";
  let offset = 0;
  for (const span of spans) {
    const start = span.index;
    result += defaultHandlers.text(
      { type: "text", value: value.slice(offset, start) },
      parent,
      state,
      {
        ...info,
        before: offset ? value.slice(0, offset) : info.before,
        after: span[0],
      },
    );
    result += span[0];
    offset = start + span[0].length;
  }
  return (
    result +
    defaultHandlers.text({ type: "text", value: value.slice(offset) }, parent, state, {
      ...info,
      before: value.slice(0, offset),
    })
  );
};
