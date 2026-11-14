/**
 * Lists on the way in: a tree of lists and items becomes a flat sequence of blocks, each
 * carrying the nesting attributes `nest` reads (`@meridian/prosemirror-schema`). Generic over the
 * leaf so Markdown (mdast) and table-cell HTML share one walk.
 */
import type { Node as PMNode } from "prosemirror-model";

export type ListSource<T> = {
  type: "list";
  ordered: boolean;
  start: number | null;
  spread: boolean;
  items: Array<{ checked: boolean | null; children: Array<Source<T>> }>;
};
export type Source<T> = { type: "leaf"; value: T } | ListSource<T>;

/** `value` is null for the empty paragraph that carries an item no block starts. */
export type FlatBlock<T> = {
  value: T | null;
  path: string | null;
  marker: "item" | "todo" | "done" | null;
  kind: "ordered" | null;
  start: number | null;
  loose: true | null;
};

export function flattenSources<T>(sources: ReadonlyArray<Source<T>>): Array<FlatBlock<T>> {
  const out: Array<FlatBlock<T>> = [];
  const own = (path: string): FlatBlock<null> => ({
    value: null,
    path: path || null,
    marker: null,
    kind: null,
    start: null,
    loose: null,
  });

  // `|` goes before the step that starts a container, on the container's first block.
  const markFresh = (block: FlatBlock<T>, depth: number) => {
    const path = block.path ?? "";
    block.path = `${path.slice(0, depth)}|${path.slice(depth)}`;
  };

  const walk = (children: ReadonlyArray<Source<T>>, path: string) => {
    let previous: Source<T> | undefined;
    for (const child of children) {
      if (child.type === "leaf") {
        out.push({ ...own(path), value: child.value });
      } else {
        const at = out.length;
        walkList(child, `${path}-`);
        if (previous?.type === "list" && previous.ordered === child.ordered) {
          markFresh(out[at] as FlatBlock<T>, path.length);
        }
      }
      previous = child;
    }
  };

  const walkList = (list: ListSource<T>, step: string) => {
    list.items.forEach((item, index) => {
      const item0: Partial<FlatBlock<T>> = {
        marker: item.checked === null ? "item" : item.checked ? "done" : "todo",
        kind: list.ordered ? "ordered" : null,
        start:
          index === 0 && list.ordered && list.start !== null && list.start !== 1
            ? list.start
            : null,
        loose: list.spread ? true : null,
      };
      const at = out.length;
      walk(item.children, step);
      // A block's marker speaks for its innermost list, so an item with no block of its
      // own (empty, or beginning with a deeper list) gets an empty paragraph.
      if (item.children.length === 0 || item.children[0]?.type === "list") {
        out.splice(at, 0, { ...own(step), ...item0 } as FlatBlock<T>);
      } else {
        Object.assign(out[at] as FlatBlock<T>, item0);
      }
    });
  };

  walk(sources, "");
  return out;
}

/** Stamps nesting onto a parsed block: the same node with the five attributes set. */
export function withNesting(node: PMNode, block: FlatBlock<unknown>): PMNode {
  return node.type.create(
    {
      ...node.attrs,
      path: block.path,
      kind: block.kind,
      marker: block.marker,
      start: block.start,
      loose: block.loose,
    },
    node.content,
    node.marks,
  );
}
