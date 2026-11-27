import { agentsLocationOf } from "@meridian/contracts/agents";
import type { ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import type { DetachedWorkTracker } from "../../shared/detached-work.js";
import { createKeyedCoalescer } from "../../shared/keyed-coalescer.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import type { ProjectWakeHub } from "./project-wake-hub.js";
import { loadDocumentAddresses } from "./tree/tree-addresses.js";

const SETTLE_MS = 250;
const PLACE_TTL_MS = 60_000;
const PLACES = 5000;

type Place = { project: ProjectId } | { user: string } | null;

export interface AgentFilesHints {
  hint(documentId: string): void;
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
      deps.wake.publishToUser(place.user, (projectId) => ({
        type: "agent-files-hint",
        projectId: projectId as ProjectId,
      }));
    }
  }

  const hints = createKeyedCoalescer<string>({
    debounceMs: SETTLE_MS,
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
