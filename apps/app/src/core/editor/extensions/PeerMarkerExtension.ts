/** Headless ProseMirror projection and writer-edit reducer for session markers. */
import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { i18n } from "@/lib/i18n";
import type { AgentNameStore } from "../agent-name-store";
import { isRemoteDocumentRebuild } from "../anchors";
import {
  changeMarkLabel,
  collaboratorChangeLabel,
  peerMarkAccessibleLabel,
} from "../change-mark-labels";
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

function markerLabel(marker: SessionMarker, agentNames?: AgentNameStore): string {
  return marker.author.kind === "agent"
    ? changeMarkLabel(
        marker.kind,
        marker.pureDeletionOffset,
        agentNames?.get(marker.author.threadId),
      )
    : collaboratorChangeLabel();
}

function interactiveAttributes(
  marker: SessionMarker,
  emphasizedId: string | null,
  agentNames?: AgentNameStore,
): Record<string, string> {
  const label = markerLabel(marker, agentNames);
  const deletion = marker.kind === "delete" || marker.pureDeletionOffset !== null;
  return {
    "data-peer-mark": marker.changeId,
    "data-peer-mark-label": label,
    role: "button",
    tabindex: "0",
    "aria-label": peerMarkAccessibleLabel(label),
    style: `--peer-mark-color: ${markerColor(marker)}`,
    ...(deletion ? { "data-peer-mark-deletion": "true" } : {}),
    ...(marker.swept ? { "data-peer-mark-swept": "true" } : {}),
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
  const blockAfter = $start.nodeAfter;
  let blockStart: number;
  let blockEnd: number;
  if (blockAfter?.isTextblock) {
    blockStart = rangeStart + 1;
    blockEnd = rangeStart + blockAfter.nodeSize - 1;
  } else {
    let depth = $start.depth;
    while (depth > 0 && !$start.node(depth).isTextblock) depth--;
    if (!$start.node(depth).isTextblock) return rangeStart;
    blockStart = $start.start(depth);
    blockEnd = $start.end(depth);
  }
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

function textRangeStart(state: EditorState, position: number): number {
  const $position = state.doc.resolve(position);
  return $position.nodeAfter?.isTextblock ? position + 1 : position;
}

function boundaryWidgetPosition(
  state: EditorState,
  position: number,
  affinity: Extract<SessionMarker["anchor"], { type: "boundary" }>["affinity"],
): number {
  const $position = state.doc.resolve(position);
  const before = $position.nodeBefore;
  const after = $position.nodeAfter;
  const beforePosition = before ? lastTextblockPosition(before, position - before.nodeSize) : null;
  const afterPosition = after ? firstTextblockPosition(after, position) : null;
  if (affinity === "after_previous") {
    return beforePosition ?? afterPosition ?? position;
  }
  return afterPosition ?? beforePosition ?? position;
}

function firstTextblockPosition(node: ProseMirrorNode, nodeStart: number): number | null {
  if (node.isTextblock) return nodeStart + 1;
  let offset = 0;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    const position = firstTextblockPosition(child, nodeStart + 1 + offset);
    if (position !== null) return position;
    offset += child.nodeSize;
  }
  return null;
}

function lastTextblockPosition(node: ProseMirrorNode, nodeStart: number): number | null {
  if (node.isTextblock) return nodeStart + node.nodeSize - 1;
  let offset = node.content.size;
  for (let index = node.childCount - 1; index >= 0; index -= 1) {
    const child = node.child(index);
    offset -= child.nodeSize;
    const position = lastTextblockPosition(child, nodeStart + 1 + offset);
    if (position !== null) return position;
  }
  return null;
}

function buildMarkerDecorations(
  store: SessionMarkerStore,
  state: EditorState,
  emphasizedId: string | null,
  agentNames?: AgentNameStore,
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
        Decoration.inline(
          position.from,
          position.to,
          {
            class: "meridian-peer-mark--range",
            ...interactiveAttributes(marker, emphasizedId, agentNames),
          },
          { changeId: marker.changeId },
        ),
      );
      continue;
    }
    const pos =
      pureDeletion && position.type === "range"
        ? pureDeletionPosition(state, position.from, marker.pureDeletionOffset ?? 0)
        : position.type === "boundary" && marker.anchor.type === "boundary"
          ? boundaryWidgetPosition(state, position.pos, marker.anchor.affinity)
          : position.type === "boundary"
            ? position.pos
            : position.from;
    decorations.push(
      Decoration.widget(
        pos,
        () => {
          const mark = document.createElement("span");
          mark.className = "meridian-peer-mark--tick";
          for (const [name, value] of Object.entries(
            interactiveAttributes(marker, emphasizedId, agentNames),
          )) {
            mark.setAttribute(name, value);
          }
          mark.setAttribute("contenteditable", "false");
          const label = document.createElement("span");
          label.className = "meridian-collab-cursor__label meridian-peer-mark__label";
          label.textContent = markerLabel(marker, agentNames);
          mark.append(label);
          return mark;
        },
        {
          side: -1,
          // ProseMirror reuses keyed widget DOM. Include emphasis state so an
          // addressed tick is rebuilt with its emphasis attribute.
          key: `${marker.changeId}:${marker.changeId === emphasizedId ? "emphasized" : "idle"}:${markerLabel(marker, agentNames)}`,
          changeId: marker.changeId,
        },
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
type MarkerPosition =
  | { type: "range"; from: number; to: number }
  | { type: "boundary"; pos: number };

/** Where each marker was drawn before this transaction touched anything. */
function priorMarkerPositions(decorations: DecorationSet): Map<string, MarkerPosition> {
  const positions = new Map<string, MarkerPosition>();
  for (const decoration of decorations.find()) {
    const changeId = decoration.spec.changeId as string | undefined;
    if (!changeId) continue;
    positions.set(
      changeId,
      decoration.from === decoration.to
        ? { type: "boundary", pos: decoration.from }
        : { type: "range", from: decoration.from, to: decoration.to },
    );
  }
  return positions;
}

export function markersClearedByWriterTransaction(
  tr: Transaction,
  oldState: EditorState,
  markers: readonly SessionMarker[],
  priorPositions: ReadonlyMap<string, MarkerPosition> = new Map(),
): string[] {
  if (!tr.docChanged || isRemoteDocumentRebuild(tr) || tr.getMeta("addToHistory") === false) {
    return [];
  }

  const cleared: string[] = [];
  for (const marker of markers) {
    if (marker.dismissed) continue;
    // Yjs has already advanced its shared document by the time ProseMirror
    // applies a local typing transaction. Relative positions at an insertion
    // boundary therefore describe the after-state. Prefer the decoration
    // coordinates captured from the plugin's actual before-state.
    const markerPosition =
      priorPositions.get(marker.changeId) ?? resolvedMarkerPosition(marker, oldState);
    if (!markerPosition) continue;
    const overlapPosition =
      markerPosition.type === "range"
        ? { ...markerPosition, from: textRangeStart(oldState, markerPosition.from) }
        : markerPosition;
    const resolved =
      marker.kind === "modify" &&
      marker.pureDeletionOffset !== null &&
      overlapPosition.type === "range"
        ? {
            type: "boundary" as const,
            pos: pureDeletionPosition(oldState, overlapPosition.from, marker.pureDeletionOffset),
          }
        : overlapPosition;
    const from = resolved.type === "range" ? resolved.from : resolved.pos;
    const to = resolved.type === "range" ? resolved.to : resolved.pos;
    let clear = false;
    for (const [mapIndex, map] of tr.mapping.maps.entries()) {
      const backToBefore = tr.mapping.slice(0, mapIndex).invert();
      map.forEach((oldStart, oldEnd, newStart, newEnd) => {
        if (clear) return;
        const beforeStart = backToBefore.map(oldStart, -1);
        const beforeEnd = backToBefore.map(oldEnd, 1);
        const insertion = oldStart === oldEnd && newEnd > newStart;
        const deletion = oldEnd > oldStart;
        if (resolved.type === "range") {
          clear =
            (deletion && beforeStart < to && beforeEnd > from) ||
            (insertion && beforeStart > from && beforeStart < to);
        } else {
          clear =
            (insertion && beforeStart === from) ||
            (deletion && beforeStart <= from && beforeEnd >= from);
        }
      });
      if (clear) break;
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
  agentNames?: AgentNameStore;
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
            if (editor.isDestroyed) return;
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
    const agentNames = this.options.agentNames;
    if (!store) return [];
    return [
      new Plugin<PeerMarkerPluginState>({
        key: peerMarkerPluginKey,
        state: {
          init: (_config, state) => ({
            decorations: buildMarkerDecorations(store, state, null, agentNames),
            pendingClearIds: [],
            emphasizedId: null,
          }),
          apply(tr, previous, oldState, newState) {
            // Only a writer's edit can clear a marker, and reading every
            // decoration's position is the expensive part of asking: a caret
            // move must not pay for it.
            const pendingClearIds = tr.docChanged
              ? markersClearedByWriterTransaction(
                  tr,
                  oldState,
                  store.getSnapshot(),
                  priorMarkerPositions(previous.decorations),
                )
              : [];
            const rebuild = tr.getMeta(REBUILD_META) === true || isRemoteDocumentRebuild(tr);
            const emphasizedMeta = tr.getMeta(EMPHASIZE_META) as string | null | undefined;
            const emphasizedId =
              emphasizedMeta === undefined ? previous.emphasizedId : emphasizedMeta;
            return {
              decorations:
                rebuild || tr.docChanged || emphasizedMeta !== undefined
                  ? buildMarkerDecorations(store, newState, emphasizedId, agentNames)
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
          const unsubscribeLocale = i18n.on("change", requestRebuild);
          // Thread titles land after the turn that created the mark, so a name
          // arriving later has to repaint labels that already rendered as "AI".
          const unsubscribeNames = agentNames?.subscribe(requestRebuild);
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
              unsubscribeLocale();
              unsubscribeNames?.();
            },
          };
        },
      }),
    ];
  },
});
