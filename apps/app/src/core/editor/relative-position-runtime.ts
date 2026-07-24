/** Shared Yjs-relative-position resolution for editor projections and navigation. */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";

export type RelativePositionRuntime = {
  doc: PMNode;
  yDoc: Y.Doc;
  yFragment: Y.XmlFragment;
  mapping: Map<Y.AbstractType<unknown>, PMNode>;
};

/** The binding is absent during the first frame of collaborative editor mount. */
export function relativePositionRuntimeFromState(
  state: Pick<EditorState, "doc">,
): RelativePositionRuntime | null {
  const pluginState = ySyncPluginKey.getState(state as EditorState) as
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

export function resolveRelativePosition(
  runtime: RelativePositionRuntime,
  position: Y.RelativePosition,
): number | null {
  const resolved = relativePositionToAbsolutePosition(
    runtime.yDoc,
    runtime.yFragment,
    position,
    runtime.mapping,
  );
  return resolved !== null && resolved >= 0 && resolved <= runtime.doc.content.size
    ? resolved
    : null;
}

export function resolveRelativeRange(
  runtime: RelativePositionRuntime,
  range: { start: Y.RelativePosition; end: Y.RelativePosition },
): { from: number; to: number } | null {
  const from = resolveRelativePosition(runtime, range.start);
  const to = resolveRelativePosition(runtime, range.end);
  return from === null || to === null ? null : { from, to };
}

export function relativePositionForIndex(
  runtime: RelativePositionRuntime,
  index: number,
): Y.RelativePosition | null {
  if (index < 0 || index > runtime.doc.content.size) return null;
  return absolutePositionToRelativePosition(index, runtime.yFragment, runtime.mapping);
}

/** Raw-Y validation used before a mounted editor binding is available. */
export function relativePositionTargetsFragment(
  position: Y.RelativePosition,
  yDoc: Y.Doc,
  fragment: Y.XmlFragment,
): boolean {
  const absolute = Y.createAbsolutePositionFromRelativePosition(position, yDoc);
  return absolute?.type === fragment;
}
