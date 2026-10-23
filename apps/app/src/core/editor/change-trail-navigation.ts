/** Authorize, open, sync, validate, and reveal a durable change-trail target. */

import { decodeNavigationPosition, validateLiveBlockRange } from "@meridian/agent-edit";
import type * as Y from "yjs";
import type { TrailChange } from "@/client/change-trails";
import type { OpenDocumentOutcome } from "@/features/project/context/open-project-document";
import {
  showLiveRangeInTarget,
  showPeerMarkerInTarget,
  waitForLiveRangeRetry,
  whenLiveEditor,
} from "./live-range-navigation-runtime";
import { claimDocumentTarget } from "./reading-position-navigation";
import { relativePositionTargetsFragment } from "./relative-position-runtime";

export type TrailNavigationResult =
  | { kind: "shown" }
  | { kind: "unavailable" }
  | { kind: "could_not_open" };

export async function navigateToTrailChange(input: {
  documentId: string;
  change: TrailChange;
  openDocument: (documentId: string) => Promise<OpenDocumentOutcome>;
  timeoutMs?: number;
  showRange?: typeof showLiveRangeInTarget;
  showMarker?: typeof showPeerMarkerInTarget;
  signal?: AbortSignal;
}): Promise<TrailNavigationResult> {
  const releaseTarget = claimDocumentTarget(input.documentId);
  try {
    const cancelled = () => input.signal?.aborted === true;
    if (cancelled()) return { kind: "could_not_open" };
    if (input.change.navigation.kind === "unavailable") return { kind: "unavailable" };
    const opened = await input.openDocument(input.documentId).catch(() => null);
    if (cancelled() || !opened || opened.kind !== "committed") return { kind: "could_not_open" };
    if (opened.placement === "background") return { kind: "could_not_open" };
    const timeoutMs = input.timeoutMs ?? 10_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const waitSignal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const target = await whenLiveEditor(input.documentId, opened.placement, waitSignal);
    if (!target || cancelled()) return { kind: "could_not_open" };
    const targetSignal = AbortSignal.any([waitSignal, target.signal]);
    const session = target.session;
    await Promise.race([
      session.whenContentConfirmed(),
      new Promise<void>((resolve) =>
        targetSignal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    if (targetSignal.aborted) return { kind: "could_not_open" };

    const sessionMarker = session.markerStore
      ?.getSnapshot()
      .some((marker) => marker.changeId === input.change.changeId && !marker.dismissed);
    if (sessionMarker) {
      const showMarker = input.showMarker ?? showPeerMarkerInTarget;
      do {
        if (targetSignal.aborted) return { kind: "could_not_open" };
        const shown = showMarker(target, input.change.changeId).shown;
        if (targetSignal.aborted) return { kind: "could_not_open" };
        if (shown) return { kind: "shown" };
        await waitForLiveRangeRetry(targetSignal);
      } while (!targetSignal.aborted);
      return { kind: "could_not_open" };
    }

    let range: { start: Y.RelativePosition; end: Y.RelativePosition };
    let boundary = false;
    if (input.change.navigation.kind === "live_block_range") {
      const resolved = validateLiveBlockRange({
        doc: session.document,
        target: input.change.navigation,
      });
      if (!resolved) return { kind: "unavailable" };
      range = resolved;
    } else {
      try {
        const position = decodeNavigationPosition(input.change.navigation.position);
        if (
          !relativePositionTargetsFragment(
            position,
            session.document,
            session.document.getXmlFragment("prosemirror"),
          )
        ) {
          return { kind: "unavailable" };
        }
        range = { start: position, end: position };
        boundary = true;
      } catch {
        return { kind: "unavailable" };
      }
    }

    const show = input.showRange ?? showLiveRangeInTarget;
    do {
      if (targetSignal.aborted) return { kind: "could_not_open" };
      if (
        input.change.navigation.kind === "live_block_range" &&
        !validateLiveBlockRange({ doc: session.document, target: input.change.navigation })
      ) {
        return { kind: "unavailable" };
      }
      const result = show(target, range, boundary);
      if (targetSignal.aborted) return { kind: "could_not_open" };
      if (result.shown) return { kind: "shown" };
      await waitForLiveRangeRetry(targetSignal);
    } while (!targetSignal.aborted);
    return { kind: "could_not_open" };
  } finally {
    releaseTarget();
  }
}
