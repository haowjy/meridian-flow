/** Canonical rich document content and visible effect clocks, independent of Yjs history. */
import { isDeepStrictEqual } from "node:util";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { ClockRange } from "./draft-review-attribution.js";

export function documentEffectsEqual(live: Y.Doc, draft: Y.Doc): boolean {
  return isDeepStrictEqual(
    visibleContent(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)),
    visibleContent(draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)),
  );
}

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

/** Visible attribute and formatting structs carry effects even when no character changes. */
export function visibleItemRanges(
  node: Y.XmlElement | Y.XmlText | Y.XmlFragment | Y.XmlHook,
  richOnly = false,
): ClockRange[] {
  const ranges: ClockRange[] = [];
  const add = (item: Y.Item | null) => {
    if (
      item &&
      !item.deleted &&
      (!richOnly || item.parentSub !== null || item.content instanceof Y.ContentFormat)
    )
      ranges.push({ client: item.id.client, clock: item.id.clock, length: item.length });
  };
  const visit = (type: typeof node) => {
    add(type._item);
    for (const item of type._map.values()) add(item);
    let item = type._start;
    while (item) {
      if (!item.deleted && item.content instanceof Y.ContentType)
        visit(item.content.type as typeof node);
      else add(item);
      item = item.right;
    }
  };
  visit(node);
  return ranges.sort((a, b) => a.client - b.client || a.clock - b.clock);
}

/** Yjs decoding and ProseMirror construction can give the same attributes different prototypes. */
export function contentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(contentValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, contentValue(item)]),
    );
  return value;
}

export function structuralShape(
  node: Y.XmlElement | Y.XmlText | Y.XmlFragment | Y.XmlHook,
): unknown {
  if (node instanceof Y.XmlText) return "text";
  if (node instanceof Y.XmlHook) return node.hookName;
  return {
    type: node instanceof Y.XmlElement ? node.nodeName : "root",
    children: node.toArray().map(structuralShape),
  };
}
