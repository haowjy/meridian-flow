/**
 * A model that read only live text plans a draft write on the draft's seed: the frontier it
 * holds for the live room, carried onto the draft's own room at the seed's cut.
 */
import {
  type FrontierLookup,
  projectSeedFrontier,
  type WriteContext,
} from "@meridian/agent-edit/integration";
import type { DraftSeedRecord } from "./draft-store.js";
import { draftRoom } from "./observation-rooms.js";

export type FrontierProjection = { workDraftId: string; seed: DraftSeedRecord | null };

/** One projection door for tool calls and their later response save. */
export function projectedFrontiers(
  frontiers: WriteContext["frontiers"],
  projections: readonly FrontierProjection[],
): WriteContext["frontiers"] {
  if (!frontiers) return frontiers;
  return {
    ...frontiers,
    recording: projectedLookup(frontiers.recording, projections),
    ...(frontiers.planning ? { planning: projectedLookup(frontiers.planning, projections) } : {}),
  };
}

export function projectedLookup(
  lookup: FrontierLookup,
  projections: readonly FrontierProjection[],
): FrontierLookup {
  const byRoom = new Map(
    projections.flatMap(({ workDraftId, seed }) =>
      seed ? [[draftRoom(workDraftId), seed] as const] : [],
    ),
  );
  if (!byRoom.size) return lookup;
  return async (room) => {
    const native = await lookup(room);
    if (native) return native;
    const seed = byRoom.get(room);
    if (!seed) return null;
    return projectSeedFrontier(await lookup(seed.liveRoom), {
      sourceRoom: seed.liveRoom,
      sourceSnapshot: seed.liveSnapshot,
      ...(seed.liveAttribution ? { sourceAttribution: seed.liveAttribution } : {}),
      targetRoom: room,
      targetSnapshot: seed.draftSnapshot,
      targetPosition: 0,
      origins: new Map(Object.entries(seed.origins)),
    });
  };
}
