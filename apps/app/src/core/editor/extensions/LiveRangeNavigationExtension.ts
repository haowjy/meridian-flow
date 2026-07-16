/** Imperative, temporary highlighting for a validated Yjs trail range or deletion boundary. */
import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import type * as Y from "yjs";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    liveRangeNavigation: {
      showLiveRange: (range: { start: Y.RelativePosition; end: Y.RelativePosition }) => ReturnType;
      showLivePosition: (position: Y.RelativePosition) => ReturnType;
      clearLiveRange: () => ReturnType;
    };
  }
}

type Highlight = { from: number; to: number; boundary: boolean } | null;
const liveRangeKey = new PluginKey<DecorationSet>("live-range-navigation");
const LIVE_RANGE_META = "live-range-navigation";
const HIGHLIGHT_DURATION_MS = 4_000;
const clearTimers = new WeakMap<Editor, ReturnType<typeof setTimeout>>();

export function relativeRangeToEditorPositions(
  editor: Editor,
  range: { start: Y.RelativePosition; end: Y.RelativePosition },
): { from: number; to: number } | null {
  const binding = ySyncPluginKey.getState(editor.state)?.binding;
  if (!binding) return null;
  const from = relativePositionToAbsolutePosition(
    binding.doc,
    binding.type,
    range.start,
    binding.mapping,
  );
  const to = relativePositionToAbsolutePosition(
    binding.doc,
    binding.type,
    range.end,
    binding.mapping,
  );
  return from === null || to === null ? null : { from, to };
}

function scrollHighlight(editor: Editor): void {
  requestAnimationFrame(() => {
    editor.view.dom
      .querySelector<HTMLElement>("[data-live-range-navigation]")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function scheduleClear(editor: Editor): void {
  const prior = clearTimers.get(editor);
  if (prior) clearTimeout(prior);
  clearTimers.set(
    editor,
    setTimeout(() => {
      clearTimers.delete(editor);
      if (!editor.isDestroyed) editor.commands.clearLiveRange();
    }, HIGHLIGHT_DURATION_MS),
  );
}

export const LiveRangeNavigationExtension = Extension.create({
  name: "liveRangeNavigation",
  addCommands() {
    return {
      showLiveRange:
        (range) =>
        ({ editor, tr, dispatch }) => {
          const positions = relativeRangeToEditorPositions(editor, range);
          if (!positions) return false;
          dispatch?.(tr.setMeta(LIVE_RANGE_META, { ...positions, boundary: false }));
          scrollHighlight(editor);
          scheduleClear(editor);
          return true;
        },
      showLivePosition:
        (position) =>
        ({ editor, tr, dispatch }) => {
          const positions = relativeRangeToEditorPositions(editor, {
            start: position,
            end: position,
          });
          if (!positions) return false;
          dispatch?.(tr.setMeta(LIVE_RANGE_META, { ...positions, boundary: true }));
          scrollHighlight(editor);
          scheduleClear(editor);
          return true;
        },
      clearLiveRange:
        () =>
        ({ tr, dispatch }) => {
          dispatch?.(tr.setMeta(LIVE_RANGE_META, null));
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: liveRangeKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, prior) {
            const meta = tr.getMeta(LIVE_RANGE_META) as Highlight | undefined;
            if (meta === undefined) return prior.map(tr.mapping, tr.doc);
            if (!meta) return DecorationSet.empty;
            const decoration =
              meta.boundary || meta.from === meta.to
                ? Decoration.widget(meta.from, () => {
                    const marker = document.createElement("span");
                    marker.dataset.liveRangeNavigation = "boundary";
                    marker.className = "live-range-navigation-boundary";
                    return marker;
                  })
                : Decoration.inline(meta.from, meta.to, {
                    "data-live-range-navigation": "range",
                    class: "live-range-navigation-highlight",
                  });
            return DecorationSet.create(tr.doc, [decoration]);
          },
        },
        props: { decorations: (state) => liveRangeKey.getState(state) ?? DecorationSet.empty },
      }),
    ];
  },
});

export function relativePositionForEditorIndex(
  editor: Editor,
  index: number,
): Y.RelativePosition | null {
  const binding = ySyncPluginKey.getState(editor.state)?.binding;
  return binding ? absolutePositionToRelativePosition(index, binding.type, binding.mapping) : null;
}
