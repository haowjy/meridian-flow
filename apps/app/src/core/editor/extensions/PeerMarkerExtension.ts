/** Headless ProseMirror projection and writer-edit reducer for session markers. */
import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  relativePositionRuntimeFromState,
  resolveRelativePosition,
  resolveRelativeRange,
} from "../relative-position-runtime";
import type { SessionMarker, SessionMarkerStore } from "../session-marker-store";

const peerMarkerPluginKey = new PluginKey<PeerMarkerPluginState>("peer-markers");
const REBUILD_META = "peer-markers:rebuild";

type PeerMarkerPluginState = {
  decorations: DecorationSet;
  pendingClearIds: readonly string[];
};

function resolvedMarkerPosition(
  marker: SessionMarker,
  state: EditorState,
): { type: "range"; from: number; to: number } | { type: "boundary"; pos: number } | null {
  const runtime = relativePositionRuntimeFromState(state);
  if (!runtime || marker.anchor.type === "unresolved") return null;
  if (marker.anchor.type === "range") {
    const range = resolveRelativeRange(runtime, marker.anchor);
    return range ? { type: "range", ...range } : null;
  }
  const pos = resolveRelativePosition(runtime, marker.anchor.position);
  return pos === null ? null : { type: "boundary", pos };
}

function buildMarkerDecorations(store: SessionMarkerStore, state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  for (const marker of store.getSnapshot()) {
    if (marker.dismissed) continue;
    const position = resolvedMarkerPosition(marker, state);
    if (!position) continue;
    if (position.type === "range" && position.to > position.from) {
      decorations.push(
        Decoration.inline(position.from, position.to, {
          class: "meridian-peer-mark--range",
          "data-peer-mark": marker.changeId,
        }),
      );
      continue;
    }
    const pos = position.type === "boundary" ? position.pos : position.from;
    decorations.push(
      Decoration.widget(
        pos,
        () => {
          const tick = document.createElement("span");
          tick.className =
            marker.anchor.type === "boundary" && marker.anchor.affinity === "document_start"
              ? "meridian-peer-mark--seam"
              : "meridian-peer-mark--tick";
          tick.dataset.peerMark = marker.changeId;
          tick.setAttribute("contenteditable", "false");
          return tick;
        },
        { side: -1, key: marker.changeId },
      ),
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

/**
 * Self-clear contract:
 *
 * Only doc-changing local-writer transactions participate. Remote y-sync
 * changes and programmatic `addToHistory:false` transactions never clear.
 * A range clears for a deletion/replacement overlapping its whole interval,
 * or an insertion strictly inside it (not at either boundary). A deletion
 * boundary clears for an insertion exactly there or a deletion covering it.
 * Marks clear whole: there is no splitting or subrange remainder.
 *
 * Positions are resolved in the transaction's before-state, then advanced
 * through each StepMap. This lets each step be tested against the coordinates
 * it actually received while retaining the relative-position binding's bounds
 * validation. Selection-only transactions have no maps and cannot clear.
 */
export function markersClearedByWriterTransaction(
  tr: Transaction,
  oldState: EditorState,
  markers: readonly SessionMarker[],
): string[] {
  if (
    !tr.docChanged ||
    (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin ===
      true ||
    tr.getMeta("addToHistory") === false
  ) {
    return [];
  }

  const cleared: string[] = [];
  for (const marker of markers) {
    if (marker.dismissed) continue;
    const resolved = resolvedMarkerPosition(marker, oldState);
    if (!resolved) continue;
    let from = resolved.type === "range" ? resolved.from : resolved.pos;
    let to = resolved.type === "range" ? resolved.to : resolved.pos;
    let clear = false;
    for (const map of tr.mapping.maps) {
      map.forEach((oldStart, oldEnd, newStart, newEnd) => {
        if (clear) return;
        const insertion = oldStart === oldEnd && newEnd > newStart;
        const deletion = oldEnd > oldStart;
        if (resolved.type === "range") {
          clear =
            (deletion && oldStart < to && oldEnd > from) ||
            (insertion && oldStart > from && oldStart < to);
        } else {
          clear =
            (insertion && oldStart === from) || (deletion && oldStart <= from && oldEnd >= from);
        }
      });
      if (clear) break;
      from = map.map(from, -1);
      to = map.map(to, 1);
    }
    if (clear) cleared.push(marker.changeId);
  }
  return cleared;
}

function anchorsResolve(store: SessionMarkerStore, state: EditorState): void {
  const runtime = relativePositionRuntimeFromState(state);
  if (!runtime) return;
  store.reconcileAnchors((anchor) =>
    anchor.type === "range"
      ? resolveRelativeRange(runtime, anchor) !== null
      : resolveRelativePosition(runtime, anchor.position) !== null,
  );
}

export const PeerMarkerExtension = Extension.create<{ markerStore: SessionMarkerStore | null }>({
  name: "peerMarkers",
  addOptions: () => ({ markerStore: null }),
  addProseMirrorPlugins() {
    const store = this.options.markerStore;
    if (!store) return [];
    return [
      new Plugin<PeerMarkerPluginState>({
        key: peerMarkerPluginKey,
        state: {
          init: (_config, state) => ({
            decorations: buildMarkerDecorations(store, state),
            pendingClearIds: [],
          }),
          apply(tr, previous, oldState, newState) {
            const pendingClearIds = markersClearedByWriterTransaction(
              tr,
              oldState,
              store.getSnapshot(),
            );
            const rebuild =
              tr.getMeta(REBUILD_META) === true ||
              (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)
                ?.isChangeOrigin === true;
            return {
              decorations: rebuild
                ? buildMarkerDecorations(store, newState)
                : previous.decorations.map(tr.mapping, tr.doc),
              pendingClearIds,
            };
          },
        },
        props: {
          decorations: (state) =>
            peerMarkerPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
        view(view) {
          let dispatchQueued = false;
          let destroyed = false;
          const requestRebuild = () => {
            if (dispatchQueued || destroyed) return;
            dispatchQueued = true;
            queueMicrotask(() => {
              dispatchQueued = false;
              if (!destroyed) view.dispatch(view.state.tr.setMeta(REBUILD_META, true));
            });
          };
          const unsubscribe = store.subscribe(requestRebuild);
          anchorsResolve(store, view.state);
          return {
            update(updatedView) {
              const state = peerMarkerPluginKey.getState(updatedView.state);
              for (const changeId of state?.pendingClearIds ?? []) store.dismiss(changeId);
              anchorsResolve(store, updatedView.state);
            },
            destroy() {
              destroyed = true;
              unsubscribe();
            },
          };
        },
      }),
    ];
  },
});
