/**
 * Decoration builder — turns the resolved hunk model into a ProseMirror
 * `DecorationSet` scoped to the current draft-doc positions.
 *
 * All position resolution routes through `Y.RelativePosition` → absolute
 * position via `y-prosemirror`'s binding mapping, so decorations survive
 * remote sync and are never coupled to a specific insert index.
 *
 * Widget rendering (deleted text) is intentionally minimal — a read-only
 * `<span>` marked `contenteditable="false"` with a `data-` attribute pair so
 * the sidebar can find and emphasize it. Widget-DOM stays outside the
 * document's text content: it must not participate in cursor movement, copy,
 * or select-all — those behaviours come from the widget spec's defaults
 * (`side: -1`, no marks, plain HTMLElement).
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { relativePositionToAbsolutePosition, ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";

import type { InlineReviewOperationKind } from "./model";
import {
  hunkKind,
  type InlineReviewModel,
  indexOperations,
  type ResolvedReviewHunk,
} from "./model";

/**
 * Everything the builder needs from the editor state to resolve anchors.
 * Injected rather than pulled from state so the builder can be tested
 * with fakes.
 */
export interface DecorationResolver {
  doc: PMNode;
  yDoc: Y.Doc;
  yFragment: Y.XmlFragment;
  /** The ProseMirror↔Yjs node mapping owned by y-prosemirror's binding. */
  mapping: Map<Y.AbstractType<unknown>, PMNode>;
}

const ADDED_CLASS = "meridian-review-added";
const WRITER_CLASS = "meridian-review-writer";
const EMPHASIS_CLASS = "meridian-review-emphasized";
const WIDGET_CLASS = "meridian-review-removed";
const HUNK_ATTR = "data-review-hunk";
const OPERATION_ATTR = "data-review-operations";

/**
 * Build a fresh `DecorationSet` from the resolved model. When an anchor no
 * longer resolves (the underlying Yjs items were deleted, or the mapping is
 * mid-rebuild), the hunk is silently dropped for this pass — the next model
 * refresh will produce anchors that resolve, or the plugin will just render
 * fewer decorations until then. Never throws.
 */
export function buildDecorations(
  model: InlineReviewModel | null,
  activeOperationId: string | null,
  resolver: DecorationResolver,
): DecorationSet {
  if (!model || model.hunks.length === 0) return DecorationSet.empty;

  const operationsById = indexOperations(model.operations);
  const decorations: Decoration[] = [];

  for (const hunk of model.hunks) {
    const kind = hunkKind(hunk, operationsById);
    const focused = activeOperationId ? hunk.operationIds.includes(activeOperationId) : false;

    const startPos = resolveAnchor(hunk.relStart, resolver);
    if (startPos == null) continue;

    // Insertion range (real text in the draft).
    if (hunk.relEnd !== hunk.relStart) {
      const endPos = resolveAnchor(hunk.relEnd, resolver);
      if (endPos != null && endPos > startPos) {
        decorations.push(
          Decoration.inline(startPos, endPos, {
            class: insertionClassName(kind, focused),
            [HUNK_ATTR]: hunk.hunkId,
            [OPERATION_ATTR]: hunk.operationIds.join(" "),
          }),
        );
      }
    }

    // Deletion widget — read-only span rendering the removed text.
    if (hunk.deletedText) {
      decorations.push(
        Decoration.widget(startPos, () => renderDeletionWidget(hunk, focused), {
          // Draw before the anchor character so a deletion that lived *at* a
          // paragraph boundary reads on the correct line.
          side: -1,
          // Widget must not be part of the document text stream — key it so
          // ProseMirror re-uses the DOM across mapped transactions instead
          // of destroying and rebuilding it.
          key: `${hunk.hunkId}:${focused ? "focus" : "rest"}`,
          ignoreSelection: true,
        }),
      );
    }
  }

  return DecorationSet.create(resolver.doc, decorations);
}

/**
 * Pull the resolver context out of an EditorState. Returns `null` if the
 * y-sync plugin hasn't finished binding yet (mapping is empty on the first
 * frame after mount), which the plugin treats as "no decorations this tick."
 */
export function resolverFromState(state: {
  doc: PMNode;
  plugins?: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: EditorState.field is typed via generics we can't parameterise here without pulling prosemirror-state.
  [key: string]: any;
}): DecorationResolver | null {
  const pluginState = ySyncPluginKey.getState(state as never) as
    | {
        doc?: Y.Doc;
        type?: Y.XmlFragment;
        binding?: { mapping: Map<Y.AbstractType<unknown>, PMNode> };
      }
    | undefined;
  if (!pluginState?.doc || !pluginState.type || !pluginState.binding) return null;
  return {
    doc: state.doc,
    yDoc: pluginState.doc,
    yFragment: pluginState.type,
    mapping: pluginState.binding.mapping,
  };
}

function resolveAnchor(anchor: Y.RelativePosition, resolver: DecorationResolver): number | null {
  const pos = relativePositionToAbsolutePosition(
    resolver.yDoc,
    resolver.yFragment,
    anchor,
    resolver.mapping,
  );
  if (pos == null) return null;
  // A resolved anchor past the document size means the referenced item was
  // deleted after the model was computed; skip until the next refresh.
  if (pos < 0 || pos > resolver.doc.content.size) return null;
  return pos;
}

function insertionClassName(kind: InlineReviewOperationKind, focused: boolean): string {
  const base = kind === "writer" ? WRITER_CLASS : ADDED_CLASS;
  return focused ? `${base} ${EMPHASIS_CLASS}` : base;
}

function renderDeletionWidget(hunk: ResolvedReviewHunk, focused: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = focused ? `${WIDGET_CLASS} ${EMPHASIS_CLASS}` : WIDGET_CLASS;
  span.setAttribute("contenteditable", "false");
  span.setAttribute(HUNK_ATTR, hunk.hunkId);
  span.setAttribute(OPERATION_ATTR, hunk.operationIds.join(" "));
  // Hidden from a11y trees by default — the sidebar surfaces the same content
  // as structured proposals; screen readers should not read strikethrough
  // widgets as inline prose.
  span.setAttribute("aria-hidden", "true");
  span.textContent = hunk.deletedText ?? "";
  return span;
}

/** Class name constants exported for tests + optional consumer selectors. */
export const inlineReviewClassNames = {
  added: ADDED_CLASS,
  writer: WRITER_CLASS,
  emphasized: EMPHASIS_CLASS,
  removed: WIDGET_CLASS,
} as const;
