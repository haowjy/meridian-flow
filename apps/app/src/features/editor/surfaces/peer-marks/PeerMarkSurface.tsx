/**
 * The peer-mark lane's entry in the chrome host: which mark is open, and what
 * the writer gets back when it closes.
 *
 * The press is the lane's own (`core/editor/extensions/peer-mark-press.ts`) —
 * a click or an Enter on a mark opens it inside the plugin that draws the marks,
 * so this reads state and renders and never listens to the manuscript itself.
 *
 * The mark is looked up live rather than captured with the press: a mark the
 * writer's own edit cleared is a popover with nothing left to be about, and a
 * marker object taken at press time would keep reporting the state it had then.
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import {
  type PeerMarkerStorage,
  peerMarkElement,
  peerMarks,
} from "@/core/editor/extensions/PeerMarkerExtension";
import {
  type PeerMarkPress,
  restorePeerMarkSelection,
} from "@/core/editor/extensions/peer-mark-press";
import type { SessionMarkerSnapshot } from "@/core/editor/session-marker-store";

import type { EditorChromeSurfaceProps } from "../../chrome";
import { PeerMarkPopover, type PeerMarkPopoverTarget } from "./PeerMarkPopover";

const NO_SUBSCRIPTION = () => () => {};
const NO_PRESS = () => null;
const NO_MARKERS: SessionMarkerSnapshot = [];
const noMarkers = () => NO_MARKERS;

export function PeerMarkSurface({ editor }: EditorChromeSurfaceProps) {
  const lane = useMemo(() => peerMarks(editor), [editor]);
  const target = usePeerMarkTarget(lane);

  // The press that is closing, kept for one beat: focus comes back during the
  // popover's teardown, by which time the store has already let go.
  const closing = useRef<PeerMarkPress | null>(null);
  closing.current = lane?.press.press ?? closing.current;

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) return;
      lane?.press.close();
    },
    [lane],
  );

  // Where the writer goes back to, run by the layer only when nothing took this
  // surface's place: Mod+K reaches here as a close, and the caret then belongs
  // to the form that opened.
  const returnFocus = useCallback(() => {
    const press = closing.current;
    if (!press) return;
    if (press.activation === "keyboard") {
      // Queried, not remembered: the mark the writer tabbed to is drawn by
      // whichever span exists once the popover has gone.
      peerMarkElement(editor, press.changeId)?.focus();
      return;
    }
    restorePeerMarkSelection(editor, press.editorSelection);
  }, [editor]);

  if (!target) return null;

  return (
    <PeerMarkPopover
      // Evidence disclosure is per mark: addressing a second mark while the
      // first is open must not inherit its open Before/After pane.
      key={target.changeId}
      editor={editor}
      target={target}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
    />
  );
}

function usePeerMarkTarget(lane: PeerMarkerStorage | null): PeerMarkPopoverTarget | null {
  const press = useSyncExternalStore(
    lane?.press.subscribe ?? NO_SUBSCRIPTION,
    () => lane?.press.press ?? null,
    NO_PRESS,
  );
  const markers = useSyncExternalStore(
    lane?.markers?.subscribe ?? NO_SUBSCRIPTION,
    () => lane?.markers?.getSnapshot() ?? NO_MARKERS,
    noMarkers,
  );

  return useMemo(() => {
    if (!press) return null;
    const marker = markers.find(
      (candidate) => candidate.changeId === press.changeId && !candidate.dismissed,
    );
    return marker ? { ...press, marker } : null;
  }, [markers, press]);
}
