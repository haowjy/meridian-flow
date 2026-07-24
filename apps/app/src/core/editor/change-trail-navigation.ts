/** Authorize, open, sync, validate, and reveal a durable change-trail target. */
import { decodeNavigationPosition, validateLiveBlockRange } from "@meridian/agent-edit";
import type * as Y from "yjs";
import type { TrailChange } from "@/client/change-trails";
import { getDocumentSessionRegistry } from "./document-session-registry";
import { showLiveRangeInEditor, showPeerMarkerInEditor } from "./live-range-navigation-runtime";
import { relativePositionTargetsFragment } from "./relative-position-runtime";

export type TrailNavigationResult =
  | { kind: "shown" }
  | { kind: "unavailable" }
  | { kind: "could_not_open" };

let navigationSequence = 0;

export async function navigateToTrailChange(input: {
  documentId: string;
  change: TrailChange;
  openDocument: (documentId: string) => Promise<boolean>;
  timeoutMs?: number;
  registry?: Pick<ReturnType<typeof getDocumentSessionRegistry>, "get" | "retain" | "release">;
  showRange?: typeof showLiveRangeInEditor;
  showMarker?: typeof showPeerMarkerInEditor;
  signal?: AbortSignal;
}): Promise<TrailNavigationResult> {
  const cancelled = () => input.signal?.aborted === true;
  if (cancelled()) return { kind: "could_not_open" };
  if (input.change.navigation.kind === "unavailable") return { kind: "unavailable" };
  const opened = await input.openDocument(input.documentId).catch(() => false);
  if (cancelled()) return { kind: "could_not_open" };
  if (!opened) return { kind: "could_not_open" };

  const registry = input.registry ?? getDocumentSessionRegistry();
  const owner = `change-trail-navigation:${++navigationSequence}`;
  registry.retain(owner, [input.documentId]);
  try {
    const session = registry.get(input.documentId);
    await Promise.race([
      session.waitForCurrentSync(input.timeoutMs ?? 10_000),
      new Promise<void>((resolve) =>
        input.signal?.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    if (cancelled()) return { kind: "could_not_open" };
    if (session.getSnapshot().status !== "synced") return { kind: "could_not_open" };

    const sessionMarker = session.markerStore
      ?.getSnapshot()
      .some((marker) => marker.changeId === input.change.changeId && !marker.dismissed);
    if (sessionMarker) {
      const showMarker = input.showMarker ?? showPeerMarkerInEditor;
      const deadline = Date.now() + (input.timeoutMs ?? 10_000);
      do {
        if (cancelled()) return { kind: "could_not_open" };
        if (showMarker(input.documentId, input.change.changeId).shown) return { kind: "shown" };
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
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

    const show = input.showRange ?? showLiveRangeInEditor;
    const deadline = Date.now() + (input.timeoutMs ?? 10_000);
    do {
      if (cancelled()) return { kind: "could_not_open" };
      if (
        input.change.navigation.kind === "live_block_range" &&
        !validateLiveBlockRange({ doc: session.document, target: input.change.navigation })
      ) {
        return { kind: "unavailable" };
      }
      const result = show(input.documentId, range, boundary);
      if (cancelled()) return { kind: "could_not_open" };
      if (result.shown) return { kind: "shown" };
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 25);
        input.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout);
            resolve(undefined);
          },
          { once: true },
        );
      });
    } while (Date.now() < deadline);
    return { kind: "could_not_open" };
  } finally {
    registry.release(owner);
  }
}
