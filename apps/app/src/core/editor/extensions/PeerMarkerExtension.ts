/** Headless ProseMirror projection and writer-edit reducer for session markers. */
import { type Editor, Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { changeMarkLabel, collaboratorChangeLabel } from "../change-mark-labels";
import { collaborationColorFor } from "../collaboration-colors";
import {
  relativePositionRuntimeFromState,
  resolveRelativePosition,
  resolveRelativeRange,
} from "../relative-position-runtime";
import type { SessionMarker, SessionMarkerStore } from "../session-marker-store";

const peerMarkerPluginKey = new PluginKey<PeerMarkerPluginState>("peer-markers");
const REBUILD_META = "peer-markers:rebuild";
const EMPHASIZE_META = "peer-markers:emphasize";
const EMPHASIS_DURATION_MS = 4_000;
const clearTimers = new WeakMap<Editor, ReturnType<typeof setTimeout>>();

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    peerMarkers: {
      showPeerMarker: (changeId: string) => ReturnType;
      clearPeerMarkerEmphasis: () => ReturnType;
    };
  }
}

type PeerMarkerPluginState = {
  decorations: DecorationSet;
  pendingClearIds: readonly string[];
  emphasizedId: string | null;
};

function markerColor(marker: SessionMarker): string {
  const identity =
    marker.author.kind === "agent" ? marker.author.threadId : `writer:${marker.author.userId}`;
  // Thread identity, rather than arrival order, keeps a peer's hue stable.
  return collaborationColorFor(identity);
}

function markerLabel(
  marker: SessionMarker,
  markerAgentName?: (threadId: string) => string | undefined,
): string {
  return marker.author.kind === "agent"
    ? changeMarkLabel(
        marker.kind,
        marker.pureDeletionOffset,
        markerAgentName?.(marker.author.threadId),
      )
    : collaboratorChangeLabel();
}

function interactiveAttributes(
  marker: SessionMarker,
  emphasizedId: string | null,
  markerAgentName?: (threadId: string) => string | undefined,
): Record<string, string> {
  const label = markerLabel(marker, markerAgentName);
  return {
    "data-peer-mark": marker.changeId,
    "data-peer-mark-label": label,
    role: "button",
    tabindex: "0",
    "aria-label": `${label}. Show change details.`,
    style: `--peer-mark-color: ${markerColor(marker)}`,
    ...(marker.changeId === emphasizedId ? { "data-peer-mark-emphasized": "true" } : {}),
  };
}

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

/** Count text from the resolved block start, clamping against concurrent edits. */
function pureDeletionPosition(state: EditorState, rangeStart: number, offset: number): number {
  const $start = state.doc.resolve(rangeStart);
  let depth = $start.depth;
  while (depth > 0 && !$start.node(depth).isTextblock) depth--;
  if (!$start.node(depth).isTextblock) return rangeStart;
  const blockStart = $start.start(depth);
  const blockEnd = $start.end(depth);
  let remaining = Math.max(0, offset);
  let resolved = blockStart;
  state.doc.nodesBetween(blockStart, blockEnd, (node, pos) => {
    if (!node.isText || remaining === 0) return remaining > 0;
    const length = node.text?.length ?? 0;
    if (remaining <= length) {
      resolved = pos + remaining;
      remaining = 0;
      return false;
    }
    remaining -= length;
    resolved = pos + length;
    return true;
  });
  return Math.min(resolved, blockEnd);
}

function buildMarkerDecorations(
  store: SessionMarkerStore,
  state: EditorState,
  emphasizedId: string | null,
  markerAgentName?: (threadId: string) => string | undefined,
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const marker of store.getSnapshot()) {
    if (marker.dismissed) continue;
    const position = resolvedMarkerPosition(marker, state);
    if (!position) continue;
    const pureDeletion =
      marker.kind === "modify" && marker.pureDeletionOffset !== null && position.type === "range";
    if (position.type === "range" && position.to > position.from && !pureDeletion) {
      decorations.push(
        Decoration.inline(position.from, position.to, {
          class: "meridian-peer-mark--range",
          ...interactiveAttributes(marker, emphasizedId, markerAgentName),
        }),
      );
      continue;
    }
    const pos =
      pureDeletion && position.type === "range"
        ? pureDeletionPosition(state, position.from, marker.pureDeletionOffset ?? 0)
        : position.type === "boundary"
          ? position.pos
          : position.from;
    decorations.push(
      Decoration.widget(
        pos,
        () => {
          const mark = document.createElement(marker.kind === "delete" ? "div" : "span");
          mark.className =
            marker.kind === "delete" ? "meridian-peer-mark--seam" : "meridian-peer-mark--tick";
          for (const [name, value] of Object.entries(
            interactiveAttributes(marker, emphasizedId, markerAgentName),
          )) {
            mark.setAttribute(name, value);
          }
          mark.setAttribute("contenteditable", "false");
          const label = document.createElement("span");
          label.className = "meridian-collab-cursor__label meridian-peer-mark__label";
          label.textContent = markerLabel(marker, markerAgentName);
          mark.append(label);
          return mark;
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
    const markerPosition = resolvedMarkerPosition(marker, oldState);
    if (!markerPosition) continue;
    const resolved =
      marker.kind === "modify" &&
      marker.pureDeletionOffset !== null &&
      markerPosition.type === "range"
        ? {
            type: "boundary" as const,
            pos: pureDeletionPosition(oldState, markerPosition.from, marker.pureDeletionOffset),
          }
        : markerPosition;
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

export const PeerMarkerExtension = Extension.create<{
  markerStore: SessionMarkerStore | null;
  markerAgentName?: (threadId: string) => string | undefined;
}>({
  name: "peerMarkers",
  addOptions: () => ({ markerStore: null }),
  addCommands() {
    return {
      showPeerMarker:
        (changeId) =>
        ({ editor, tr, dispatch }) => {
          const store = this.options.markerStore;
          if (
            !store
              ?.getSnapshot()
              .some((marker) => marker.changeId === changeId && !marker.dismissed)
          ) {
            return false;
          }
          dispatch?.(tr.setMeta(EMPHASIZE_META, changeId));
          requestAnimationFrame(() => {
            editor.view.dom
              .querySelector<HTMLElement>(`[data-peer-mark="${CSS.escape(changeId)}"]`)
              ?.scrollIntoView({ block: "center", behavior: "smooth" });
          });
          const prior = clearTimers.get(editor);
          if (prior) clearTimeout(prior);
          clearTimers.set(
            editor,
            setTimeout(() => {
              clearTimers.delete(editor);
              if (!editor.isDestroyed) editor.commands.clearPeerMarkerEmphasis();
            }, EMPHASIS_DURATION_MS),
          );
          return true;
        },
      clearPeerMarkerEmphasis:
        () =>
        ({ tr, dispatch }) => {
          dispatch?.(tr.setMeta(EMPHASIZE_META, null));
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    const store = this.options.markerStore;
    const markerAgentName = this.options.markerAgentName;
    if (!store) return [];
    return [
      new Plugin<PeerMarkerPluginState>({
        key: peerMarkerPluginKey,
        state: {
          init: (_config, state) => ({
            decorations: buildMarkerDecorations(store, state, null, markerAgentName),
            pendingClearIds: [],
            emphasizedId: null,
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
            const emphasizedMeta = tr.getMeta(EMPHASIZE_META) as string | null | undefined;
            const emphasizedId =
              emphasizedMeta === undefined ? previous.emphasizedId : emphasizedMeta;
            return {
              decorations:
                rebuild || emphasizedMeta !== undefined
                  ? buildMarkerDecorations(store, newState, emphasizedId, markerAgentName)
                  : previous.decorations.map(tr.mapping, tr.doc),
              pendingClearIds,
              emphasizedId,
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
