/** Canonical visible rich content for committed live trail comparisons. */
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";

export function visibleContent(
  node: Y.XmlFragment | Y.XmlElement | Y.XmlText | Y.XmlHook,
): unknown {
  if (node instanceof Y.XmlHook)
    return { hook: node.hookName, values: contentValue(node.toJSON()) };
  if (node instanceof Y.XmlText) {
    const runs: { insert: unknown; attributes: unknown }[] = [];
    for (const delta of node.toDelta()) {
      const attributes = contentValue(delta.attributes ?? {});
      const previous = runs.at(-1);
      if (
        previous &&
        typeof previous.insert === "string" &&
        typeof delta.insert === "string" &&
        isDeepStrictEqual(previous.attributes, attributes)
      )
        previous.insert += delta.insert;
      else runs.push({ insert: contentValue(delta.insert), attributes });
    }
    return { text: runs };
  }
  return {
    ...(node instanceof Y.XmlElement
      ? { type: node.nodeName, attributes: contentValue(node.getAttributes()) }
      : {}),
    children: node.toArray().map(visibleContent),
  };
}

/** Yjs decoding and ProseMirror construction can give the same attributes different prototypes. */
function contentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(contentValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, contentValue(item)]),
    );
  return value;
}
