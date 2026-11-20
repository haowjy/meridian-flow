/**
 * Wakes the clients that show an Agents level when the text of one of its documents changes, by
 * whatever wrote it: another tab, `./mf`, the AI. Without it a file's verdict is read once, when
 * the tree first lists it, which for a file made and then filled is its empty text.
 */

import { agentsLocationOf } from "@meridian/contracts/agents";
import type { ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import type { DetachedWorkTracker } from "../../shared/detached-work.js";
import { createKeyedCoalescer } from "../../shared/keyed-coalescer.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import type { ProjectWakeHub } from "./project-wake-hub.js";
import { loadDocumentAddresses } from "./tree/tree-addresses.js";

/** Writes to one document within this window wake its clients once. */
const SETTLE_MS = 250;
/** A document rarely moves in or out of an Agents level, so where it is is kept for a while. */
const PLACE_TTL_MS = 60_000;
const PLACES = 5000;

type Place = { project: ProjectId } | { user: string } | null;

export interface AgentFilesHints {
  /** Schedules a wake for the document's clients. Ignored once stopped. */
  hint(documentId: string): void;
  /** Cancels pending wakes; the ones already reading are tracked in `backgroundTasks`. */
  stop(): void;
}

export function createAgentFilesHints(deps: {
  db: Database;
  backgroundTasks: DetachedWorkTracker;
  wake: Pick<ProjectWakeHub, "publish" | "publishToUser">;
  eventSink?: EventSink;
}): AgentFilesHints {
  const places = new Map<string, { place: Place; at: number }>();

  async function placeOf(documentId: string): Promise<Place> {
    const known = places.get(documentId);
    if (known && Date.now() - known.at < PLACE_TTL_MS) return known.place;
    const [address] = await loadDocumentAddresses(deps.db, { ids: [documentId] });
    const at = address && !address.deleted ? agentsLocationOf(address.scheme, address.path) : null;
    const place: Place = !at
      ? null
      : address.owner.kind === "account"
        ? { user: address.owner.userId }
        : { project: address.owner.projectId as ProjectId };
    places.delete(documentId);
    places.set(documentId, { place, at: Date.now() });
    if (places.size > PLACES) places.delete(places.keys().next().value as string);
    return place;
  }

  async function wake(documentId: string) {
    const place = await placeOf(documentId);
    if (!place) return;
    if ("project" in place) {
      deps.wake.publish({ type: "agent-files-hint", projectId: place.project });
    } else {
      // `~/.agents/` is the writer's in every project they have open.
      deps.wake.publishToUser(place.user, (projectId) => ({
        type: "agent-files-hint",
        projectId: projectId as ProjectId,
      }));
    }
  }

  const hints = createKeyedCoalescer<string>({
    debounceMs: SETTLE_MS,
    // Lossy: a missed hint leaves a verdict stale until the next read.
    run: (documentId) => deps.backgroundTasks.track(wake(documentId), "agent-files-hint"),
    onError: (documentId, cause) => {
      if (deps.eventSink)
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "context.agent-files-hint",
          name: "AgentFilesHintFailed",
          correlation: { documentId },
          payload: unknownToEventPayload(cause),
        });
    },
  });

  return {
    hint: hints.schedule,
    stop() {
      void hints.stop();
    },
  };
}
