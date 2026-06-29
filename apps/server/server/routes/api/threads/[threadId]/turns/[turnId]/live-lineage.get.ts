/** GET /api/threads/:threadId/turns/:turnId/live-lineage: live document lineage for a turn. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import {
  handleTurnLiveLineageRequest,
  selectTurnLiveLineageRouteServices,
} from "../../../../../../lib/turn-live-lineage-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleTurnLiveLineageRequest(selectTurnLiveLineageRouteServices(app), {
    threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId,
    turnId: (getRouterParam(event, "turnId") ?? "") as TurnId,
    userId: user.userId,
  });
});
