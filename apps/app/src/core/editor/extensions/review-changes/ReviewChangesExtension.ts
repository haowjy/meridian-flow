/**
 * Review changes on the one editor of a draft page (design §6, "Three page states, one editor"):
 * the reference's text of each changed paragraph as read-only DOM above the draft's (Inline) or
 * beside every paragraph (Side by side), the words each side alone has marked, and in the right
 * margin the change's `×` / `✓` pair against Live, or `Take` against another draft. All of it is
 * decorations: the draft's text stays the editor's, editable, with its one Ctrl+Z history. Only
 * `takeRow` writes, as an edit.
 *
 * The rows are read from the fork's copy and the reference's after the document settles, never
 * inside a keystroke: decorations map through typing and are rebuilt once the writer pauses, so a
 * 10,000-word chapter types as fast with Review changes on as off.
 */
import { type RoomDocs, readDocument, type ShapeBlock } from "@meridian/document-model";
import { blocksOf, inlineNodes, loroSyncKey, nodeOf } from "@meridian/loro-prosemirror";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  blockText,
  draftDifferenceRows,
  fileDifferenceRows,
  type ReviewParagraph,
  type ReviewRow,
  reviewRows,
  takenBlockId,
  textHash,
} from "./review-rows";

export type ReviewVerdict = "apply" | "discard";

export type ReviewChangesConfig = {
  layout: "inline" | "side" | "count";
  against: "live" | "draft" | "file";
  target: string;
  reference: RoomDocs | null;
  draftId: string;
  focus: string | null;
  hidden: ReadonlySet<string>;
  labels: {
    apply: string;
    discard: string;
    restore: string;
    take: string;
    moved: string;
    restyled: string;
    comment: string;
    image: string;
  };
  press: (verdict: ReviewVerdict, row: ReviewRow) => void;
  take: (row: ReviewRow) => void;
  focusRow: (row: ReviewRow) => void;
  onRows: (rows: readonly ReviewRow[]) => void;
};

type ReviewState = {
  config: ReviewChangesConfig | null;
  rows: readonly ReviewRow[];
  decorations: DecorationSet;
};

type ReviewMeta = { config: ReviewChangesConfig | null } | { rows: readonly ReviewRow[] };

export const reviewChangesKey = new PluginKey<ReviewState>("review-changes");
const SETTLE_MS = 150;

export function setReviewChanges(view: EditorView, config: ReviewChangesConfig | null): void {
  view.dispatch(
    view.state.tr
      .setMeta(reviewChangesKey, { config } satisfies ReviewMeta)
      .setMeta("addToHistory", false),
  );
}

export function reviewRowsOf(state: EditorState): readonly ReviewRow[] {
  return reviewChangesKey.getState(state)?.rows ?? [];
}

function blockPositions(doc: Node): Map<string, number> {
  const positions = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (typeof node.attrs.id === "string") positions.set(node.attrs.id, pos);
    return !node.isTextblock;
  });
  return positions;
}

function textRanges(node: Node, pos: number, spans: readonly (readonly [number, number])[]) {
  const ranges: [number, number][] = [];
  if (spans.length === 0) return ranges;
  const map: { offset: number; pos: number; length: number }[] = [];
  let offset = 0;
  node.forEach((child, childOffset) => {
    if (child.isText) {
      map.push({ offset, pos: pos + 1 + childOffset, length: child.text?.length ?? 0 });
      offset += child.text?.length ?? 0;
    }
  });
  const at = (text: number) => {
    for (const run of map)
      if (text <= run.offset + run.length) return run.pos + Math.max(0, text - run.offset);
    const last = map.at(-1);
    return last ? last.pos + last.length : pos + 1;
  };
  for (const [from, to] of spans) if (to > from) ranges.push([at(from), at(to)]);
  return ranges;
}

function addedSpans(paragraph: ReviewParagraph): [number, number][] {
  const spans: [number, number][] = [];
  let offset = 0;
  for (const part of paragraph.words) {
    if (part.kind === "removed") continue;
    if (part.kind === "added") spans.push([offset, offset + part.text.length]);
    offset += part.text.length;
  }
  return spans;
}

function blockElement(level: number): HTMLElement {
  return document.createElement(level ? `h${Math.min(6, Math.max(1, level))}` : "p");
}

function blockReference(
  block: ShapeBlock,
  removed: boolean,
  labels: ReviewChangesConfig["labels"],
) {
  if (block.node === "horizontal_rule") {
    const rule = document.createElement("hr");
    rule.className = `meridian-review-ref${removed ? " meridian-review-del" : ""}`;
    return rule;
  }
  const element = document.createElement("p");
  element.className = "meridian-review-ref";
  const text =
    block.node === "figure"
      ? String(block.attrs.caption || block.attrs.alt || "") || labels.image
      : [...textOf([block]).values()].join(" ");
  if (!removed) element.textContent = text;
  else {
    const span = document.createElement("span");
    span.className = "meridian-review-del";
    span.textContent = text;
    element.append(span);
  }
  return element;
}

function referenceElement(
  paragraph: ReviewParagraph,
  labels: ReviewChangesConfig["labels"],
): HTMLElement {
  const live = paragraph.reference;
  if (live && live.kind !== "text")
    return blockReference(live, paragraph.kind === "removed", labels);
  const element = blockElement(Number(live?.attrs.level ?? 0));
  element.className = "meridian-review-ref";
  if (!live) return element;
  if (paragraph.kind === "removed") {
    const removed = document.createElement("span");
    removed.className = "meridian-review-del";
    removed.textContent = blockText(live);
    element.append(removed);
    return element;
  }
  if (paragraph.kind === "edited")
    for (const part of paragraph.words) {
      if (part.kind === "added") continue;
      if (part.kind === "same") element.append(part.text);
      else {
        const removed = document.createElement("span");
        removed.className = "meridian-review-del";
        removed.textContent = part.text;
        element.append(removed);
      }
    }
  else element.textContent = blockText(live);
  return element;
}

function noteElement(paragraph: ReviewParagraph, config: ReviewChangesConfig): HTMLElement {
  const note = document.createElement("p");
  note.className = "meridian-review-ref meridian-review-note";
  const kind = paragraph.kind;
  const tag = document.createElement("span");
  tag.className = "meridian-review-tag";
  tag.textContent =
    kind === "moved"
      ? config.labels.moved
      : kind === "restyled"
        ? config.labels.restyled
        : config.labels.comment;
  note.append(tag);
  if (kind !== "comment") return note;
  const body = document.createElement("span");
  body.className = "meridian-review-comment";
  for (const part of paragraph.words) {
    if (part.kind === "same") body.append(part.text);
    else {
      const word = document.createElement("span");
      word.className = part.kind === "added" ? "meridian-review-ins" : "meridian-review-del";
      word.textContent = part.text;
      body.append(word);
    }
  }
  note.append(body);
  return note;
}

const textUnchanged = (paragraph: ReviewParagraph) =>
  paragraph.kind === "moved" || paragraph.kind === "restyled" || paragraph.kind === "comment";

/**
 * What a row's widget draws: its target, the reference's text, the words marked, the actions and
 * their labels. A widget whose key holds still is reused as it is, click handlers included, so
 * anything it draws must be in the key.
 */
function drawnKey(row: ReviewRow, config: ReviewChangesConfig, focused: boolean): string {
  const parts = [
    config.target,
    String(focused),
    String(row.removed),
    ...Object.values(config.labels),
  ];
  for (const paragraph of row.paragraphs) {
    const reference = paragraph.reference;
    parts.push(paragraph.id, paragraph.kind, paragraph.before ?? "");
    if (reference)
      parts.push(
        reference.node,
        JSON.stringify(reference.attrs),
        reference.kind === "text" ? blockText(reference) : [...textOf([reference]).values()].join(),
      );
    for (const word of paragraph.words) parts.push(word.kind, word.text);
  }
  return `${row.id}:${textHash(parts.join("\u0000")).toString(36)}`;
}

function pairElement(row: ReviewRow, config: ReviewChangesConfig): HTMLElement | null {
  if (config.against === "file") return null;
  const pair = document.createElement("span");
  pair.className = "meridian-review-pair";
  const button = (kind: string, label: string, glyph: string, act: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `meridian-review-act meridian-review-${kind}`;
    element.setAttribute("aria-label", label);
    element.title = label;
    element.dataset.glyph = glyph;
    // The caret stays where the writer left it: the press is not an edit at the click.
    element.addEventListener("mousedown", (event) => event.preventDefault());
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      act();
    });
    return element;
  };
  if (config.against === "draft") {
    const take = button("take", config.labels.take, "take", () => config.take(row));
    take.textContent = config.labels.take;
    pair.append(take);
    return pair;
  }
  pair.append(
    button(
      "discard",
      row.removed ? config.labels.restore : config.labels.discard,
      row.removed ? "restore" : "discard",
      () => config.press("discard", row),
    ),
    button("apply", config.labels.apply, "apply", () => config.press("apply", row)),
  );
  return pair;
}

function cellOf(row: ReviewRow, config: ReviewChangesConfig, focused: boolean, view: EditorView) {
  const cell = document.createElement("div");
  cell.className = `meridian-review-chg${focused ? " is-focused" : ""}`;
  cell.contentEditable = "false";
  cell.dataset.reviewRow = row.id;
  cell.addEventListener("mousedown", (event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    config.focusRow(row);
    view.focus();
  });
  return cell;
}

function rowWidget(row: ReviewRow, config: ReviewChangesConfig, focused: boolean) {
  return (view: EditorView) => {
    const wrap = cellOf(row, config, focused, view);
    for (const paragraph of row.paragraphs)
      if (textUnchanged(paragraph)) wrap.append(noteElement(paragraph, config));
      else if (paragraph.kind !== "added") wrap.append(referenceElement(paragraph, config.labels));
    const pair = pairElement(row, config);
    if (pair) wrap.append(pair);
    return wrap;
  };
}

function sideCell(
  row: ReviewRow,
  paragraph: ReviewParagraph,
  config: ReviewChangesConfig,
  focused: boolean,
  first: boolean,
) {
  return (view: EditorView) => {
    const cell = cellOf(row, config, focused, view);
    if (paragraph.kind === "comment") cell.classList.add("meridian-review-across");
    else
      cell.append(
        paragraph.kind === "added" ? emptyCell() : referenceElement(paragraph, config.labels),
      );
    if (textUnchanged(paragraph)) cell.append(noteElement(paragraph, config));
    const pair = first ? pairElement(row, config) : null;
    if (pair) cell.append(pair);
    return cell;
  };
}

function emptyCell(): HTMLElement {
  const element = document.createElement("p");
  element.className = "meridian-review-ref";
  return element;
}

function draftHole() {
  const element = document.createElement("div");
  element.className = "meridian-review-hole";
  element.contentEditable = "false";
  return element;
}

function sideReference(text: string, node: Node) {
  return () => {
    const element = blockElement(Number(node.attrs.level ?? 0));
    element.className = "meridian-review-ref meridian-review-same";
    element.contentEditable = "false";
    element.textContent = text;
    return element;
  };
}

function buildDecorations(
  state: EditorState,
  config: ReviewChangesConfig,
  rows: readonly ReviewRow[],
): DecorationSet {
  const doc = state.doc;
  const side = config.layout === "side";
  const positions = blockPositions(doc);
  const decorations: Decoration[] = [];
  const rowed = new Set<string>();
  // Side by side, the grid pairs cells in DOM order: every paragraph adds one cell to each column.
  // A removal's pair sits before the paragraph it precedes, whose own cells come after it
  // (`side` -1); `order` keeps the removals in reading order among themselves.
  let order = -10_000;
  for (const row of rows) {
    if (config.hidden.has(row.id)) continue;
    const focused = row.id === config.focus;
    const tone = focused ? " is-focused" : "";
    const drawn = drawnKey(row, config, focused);
    if (!side) {
      const at = row.anchor ? positions.get(row.anchor) : undefined;
      decorations.push(
        Decoration.widget(at ?? doc.content.size, rowWidget(row, config, focused), {
          side: -1,
          key: `review:${drawn}`,
          ignoreSelection: true,
        }),
      );
    }
    row.paragraphs.forEach((paragraph, index) => {
      if (side) {
        const before = paragraph.before === null ? undefined : positions.get(paragraph.before);
        const at = before ?? doc.content.size;
        const removed = paragraph.kind === "removed";
        const key = `review:${paragraph.id}:${drawn}`;
        const cell = sideCell(row, paragraph, config, focused, index === 0);
        decorations.push(
          Decoration.widget(at, cell, {
            side: removed ? order++ : -1,
            key,
            ignoreSelection: true,
          }),
        );
        if (removed)
          decorations.push(
            Decoration.widget(at, draftHole, {
              side: order++,
              key: `hole:${paragraph.id}`,
              ignoreSelection: true,
            }),
          );
      }
      if (paragraph.kind === "removed" || paragraph.kind === "comment") return;
      const pos = positions.get(paragraph.id);
      if (pos === undefined) return;
      const node = doc.nodeAt(pos);
      if (!node) return;
      rowed.add(paragraph.id);
      const whole = paragraph.kind === "added" && !node.isTextblock ? " meridian-review-added" : "";
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: `meridian-review-draft${whole}${tone}`,
          "data-review-row": row.id,
        }),
      );
      if (!node.isTextblock) return;
      const spans =
        paragraph.kind === "added"
          ? [[0, node.textContent.length] as [number, number]]
          : addedSpans(paragraph);
      for (const [from, to] of textRanges(node, pos, spans))
        decorations.push(Decoration.inline(from, to, { class: `meridian-review-ins${tone}` }));
    });
  }
  if (side) {
    const reference = referenceOf(state, config);
    const live = reference ? textOf(readDocument(reference)) : new Map<string, string>();
    doc.forEach((node, offset) => {
      const id = node.attrs.id;
      if (typeof id === "string" && rowed.has(id)) return;
      const text = live.get(id) ?? node.textContent;
      decorations.push(
        Decoration.widget(offset, sideReference(text, node), {
          side: -1,
          key: `same:${id}:${node.type.name}${node.attrs.level ?? ""}:${textHash(text).toString(36)}`,
          ignoreSelection: true,
        }),
      );
    });
  }
  return DecorationSet.create(doc, decorations);
}

function textOf(blocks: readonly ShapeBlock[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const block of blocks)
    texts.set(
      block.id,
      block.kind === "text" ? blockText(block) : [...textOf(block.children).values()].join("\n"),
    );
  return texts;
}

function referenceOf(state: EditorState, config: ReviewChangesConfig): RoomDocs | null {
  if (config.against !== "live") return config.reference;
  return loroSyncKey.getState(state)?.docs?.live ?? null;
}

function readRows(state: EditorState, config: ReviewChangesConfig): ReviewRow[] | null {
  const docs = loroSyncKey.getState(state)?.docs;
  if (!docs?.live) return null;
  const reference = referenceOf(state, config);
  if (!reference) return [];
  const fork = blocksOf(state.doc);
  if (config.against === "draft")
    return draftDifferenceRows(readDocument(reference), fork, {
      own: config.draftId,
      other: config.target,
    });
  if (config.against === "file") return fileDifferenceRows(readDocument(reference), fork);
  return reviewRows(docs, readDocument(reference), fork);
}

function positionOf(doc: Node, id: string): number | null {
  return blockPositions(doc).get(id) ?? null;
}

export function takeRow(view: EditorView, row: ReviewRow, draftId: string): void {
  const { schema } = view.state;
  const tr = view.state.tr;
  for (const paragraph of [...row.paragraphs].reverse()) {
    const doc = tr.doc;
    if (paragraph.kind === "removed" && paragraph.reference) {
      const id = takenBlockId(paragraph.id, draftId);
      if (positionOf(doc, id) !== null) continue;
      const before = paragraph.before === null ? null : positionOf(doc, paragraph.before);
      const node = nodeOf(schema, { ...paragraph.reference, id });
      tr.insert(before ?? doc.content.size, node);
      continue;
    }
    const pos = positionOf(doc, paragraph.id);
    const node = pos === null ? null : doc.nodeAt(pos);
    if (pos === null || !node) continue;
    if (paragraph.kind === "added") {
      tr.delete(pos, pos + node.nodeSize);
      continue;
    }
    const reference = paragraph.reference;
    if (reference?.kind !== "text") continue;
    if (nodeOf(schema, { ...reference, id: node.attrs.id }).eq(node)) continue;
    tr.replaceWith(pos + 1, pos + node.nodeSize - 1, inlineNodes(schema, reference.inline));
    tr.setNodeMarkup(pos, schema.nodes[reference.node], { ...reference.attrs, id: node.attrs.id });
  }
  if (tr.docChanged) view.dispatch(tr);
}

function paints(config: ReviewChangesConfig | null | undefined): config is ReviewChangesConfig {
  return !!config && config.layout !== "count";
}

export const ReviewChangesExtension = Extension.create({
  name: "reviewChanges",
  addProseMirrorPlugins() {
    return [
      new Plugin<ReviewState>({
        key: reviewChangesKey,
        state: {
          init: () => ({ config: null, rows: [], decorations: DecorationSet.empty }),
          apply(tr, prior, _old, next) {
            const meta = tr.getMeta(reviewChangesKey) as ReviewMeta | undefined;
            if (meta && "config" in meta) {
              const same =
                meta.config &&
                prior.config?.target === meta.config.target &&
                prior.config.reference === meta.config.reference;
              const rows = same ? prior.rows : [];
              return {
                config: meta.config,
                rows,
                decorations: paints(meta.config)
                  ? buildDecorations(next, meta.config, rows)
                  : DecorationSet.empty,
              };
            }
            if (meta && "rows" in meta && prior.config)
              return {
                ...prior,
                rows: meta.rows,
                decorations: paints(prior.config)
                  ? buildDecorations(next, prior.config, meta.rows)
                  : DecorationSet.empty,
              };
            if (!tr.docChanged || !paints(prior.config)) return prior;
            return { ...prior, decorations: prior.decorations.map(tr.mapping, tr.doc) };
          },
        },
        props: {
          decorations: (state) => reviewChangesKey.getState(state)?.decorations,
          attributes: (state): Record<string, string> => {
            const config = reviewChangesKey.getState(state)?.config;
            return paints(config)
              ? { class: `meridian-review meridian-review-${config.layout}` }
              : {};
          },
        },
        view: () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let shownConfig: ReviewChangesConfig | null = null;
          let watched: RoomDocs | null = null;
          let unwatch = () => {};
          const read = (view: EditorView) => {
            timer = undefined;
            if (view.isDestroyed) return;
            const state = reviewChangesKey.getState(view.state);
            if (!state?.config) return;
            const rows = readRows(view.state, state.config) ?? [];
            state.config.onRows(rows);
            view.dispatch(
              view.state.tr
                .setMeta(reviewChangesKey, { rows } satisfies ReviewMeta)
                .setMeta("addToHistory", false),
            );
          };
          const readSoon = (view: EditorView) => {
            clearTimeout(timer);
            timer = setTimeout(() => read(view), SETTLE_MS);
          };
          const watch = (view: EditorView, live: RoomDocs | null) => {
            if (live === watched) return;
            unwatch();
            watched = live;
            unwatch = live?.beforeImport(() => readSoon(view)) ?? (() => {});
          };
          return {
            update(view, previous) {
              const config = reviewChangesKey.getState(view.state)?.config ?? null;
              const turnedOn =
                config !== null &&
                (shownConfig === null ||
                  shownConfig.target !== config.target ||
                  shownConfig.reference !== config.reference);
              shownConfig = config;
              watch(view, config ? referenceOf(view.state, config) : null);
              if (!config) {
                clearTimeout(timer);
                timer = undefined;
                return;
              }
              if (turnedOn) {
                clearTimeout(timer);
                queueMicrotask(() => read(view));
                return;
              }
              if (view.state.doc !== previous.doc) readSoon(view);
            },
            destroy() {
              clearTimeout(timer);
              unwatch();
            },
          };
        },
      }),
    ];
  },
});
