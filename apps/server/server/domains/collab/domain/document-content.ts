/** Canonical rich document content and visible effect clocks, independent of Yjs history. */
import { isDeepStrictEqual } from "node:util";
import type { ReviewFormattingChange } from "@meridian/contracts/drafts";
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

export function textContentShape(
  node: Y.XmlElement | Y.XmlText | Y.XmlFragment | Y.XmlHook,
): unknown {
  if (node instanceof Y.XmlText) return plainText(node);
  if (node instanceof Y.XmlHook) return node.hookName;
  return {
    type: node instanceof Y.XmlElement ? node.nodeName : "root",
    children: node.toArray().map(textContentShape),
  };
}

/** Attribute values and mark intervals, not unrelated recreated clocks, supply rich-only effects. */
export function richDifference(
  live: Y.XmlElement,
  draft: Y.XmlElement,
): {
  insertedRanges: ClockRange[];
  deletedRanges: ClockRange[];
  formatting: ReviewFormattingChange[];
} {
  const insertedRanges: ClockRange[] = [],
    deletedRanges: ClockRange[] = [];
  const formatting: ReviewFormattingChange[] = [];
  const add = (ranges: ClockRange[], item: Y.Item | undefined) => {
    if (
      item &&
      !ranges.some((range) => range.client === item.id.client && range.clock === item.id.clock)
    )
      ranges.push({ client: item.id.client, clock: item.id.clock, length: item.length });
  };
  const visit = (before: Y.XmlElement | Y.XmlText | Y.XmlHook, after: typeof before) => {
    if (before instanceof Y.XmlElement && after instanceof Y.XmlElement) {
      const a = before.getAttributes(),
        b = after.getAttributes();
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (isDeepStrictEqual(contentValue(a[key]), contentValue(b[key]))) continue;
        if (b[key] !== undefined) add(insertedRanges, after._map.get(key));
        else add(deletedRanges, after._map.get(key) ?? before._map.get(key));
      }
      const left = before.toArray(),
        right = after.toArray();
      for (let i = 0; i < left.length; i++) visit(left[i], right[i]);
    } else if (before instanceof Y.XmlText && after instanceof Y.XmlText) {
      const runs = (text: Y.XmlText) => {
        const result: { start: number; end: number; attributes: Record<string, unknown> }[] = [];
        let offset = 0;
        for (const run of text.toDelta()) {
          const start = offset;
          offset += typeof run.insert === "string" ? run.insert.length : 0;
          const attributes = contentValue(run.attributes ?? {}) as Record<string, unknown>;
          const previous = result.at(-1);
          if (previous && isDeepStrictEqual(previous.attributes, attributes)) previous.end = offset;
          else result.push({ start, end: offset, attributes });
        }
        return result;
      };
      const changes: {
        mark: string;
        start: number;
        end: number;
        before: unknown;
        after: unknown;
      }[] = [];
      const left = runs(before),
        right = runs(after),
        prose = plainText(after);
      let i = 0,
        j = 0,
        previousEnd = -1;
      while (i < left.length && j < right.length) {
        const a = left[i],
          b = right[j];
        const start = Math.max(a.start, b.start),
          end = Math.min(a.end, b.end);
        if (end > start)
          for (const mark of new Set([
            ...Object.keys(a.attributes),
            ...Object.keys(b.attributes),
          ])) {
            const old = a.attributes[mark],
              current = b.attributes[mark];
            if (isDeepStrictEqual(old, current)) continue;
            changes.push({ mark, start, end, before: old, after: current });
            const change =
              old === undefined ? "added" : current === undefined ? "removed" : "changed";
            const text = prose.slice(start, end),
              previous = formatting.at(-1);
            if (
              previous?.kind === "mark" &&
              previous.mark === mark &&
              previous.change === change &&
              previousEnd === start
            )
              previous.text += text;
            else formatting.push({ kind: "mark", mark, change, text });
            previousEnd = end;
          }
        if (a.end <= b.end) i++;
        if (b.end <= a.end) j++;
      }
      const changedMarkers = (text: Y.XmlText, ranges: ClockRange[], side: "before" | "after") => {
        let offset = 0;
        for (let item = text._start; item; item = item.right) {
          if (item.deleted) continue;
          if (item.content instanceof Y.ContentString) offset += item.length;
          else if (item.content instanceof Y.ContentFormat) {
            const format = item.content;
            if (
              changes.some(
                (change) =>
                  change.mark === format.key &&
                  change.start <= offset &&
                  offset < change.end &&
                  isDeepStrictEqual(contentValue(format.value), contentValue(change[side] ?? null)),
              )
            )
              add(ranges, item);
          }
        }
      };
      changedMarkers(before, deletedRanges, "before");
      changedMarkers(after, insertedRanges, "after");
    }
  };
  visit(live, draft);
  if (live.nodeName === "heading" && live.getAttribute("level") !== draft.getAttribute("level"))
    formatting.unshift({
      kind: "heading",
      before: Number(live.getAttribute("level") ?? 1),
      after: Number(draft.getAttribute("level") ?? 1),
    });
  return {
    insertedRanges,
    deletedRanges,
    formatting: formatting.length ? formatting : [{ kind: "attributes" }],
  };
}

function plainText(node: Y.XmlText): string {
  return node
    .toDelta()
    .map((run: { insert: unknown }) => (typeof run.insert === "string" ? run.insert : ""))
    .join("");
}
