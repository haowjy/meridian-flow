/**
 * POST draft/provenance: the one-room evidence request of a tab on protocol 3, answered through
 * `drafts/provenance`. Delete in the release after the one that raised `MIN_PROTOCOL_VERSION` to 4.
 */
import type { BranchId } from "@meridian/contracts";
import { draftOwnerKey } from "@meridian/contracts/branches";
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import type { ProjectId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../../lib/auth-gate.js";
import {
  requireBranchAccess,
  selectBranchRouteServices,
} from "../../../../../../../../../lib/branch-review-route.js";
import { handleDraftsProvenance } from "../../../../../../../../../lib/draft-provenance-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = (getRouterParam(event, "projectId") ?? "") as ProjectId;
  const { owner } = await requireBranchAccess(selectBranchRouteServices(app), {
    userId: user.userId,
    projectId,
    branchId: (getRouterParam(event, "branchId") ?? "") as BranchId,
  });
  const body: unknown = await readBody(event);
  const roomName =
    typeof body === "object" && body && "roomName" in body ? String(body.roomName) : "";
  const room = parseYjsRoomName(roomName);
  if (room?.kind !== "draft")
    throw createError({ statusCode: 400, message: "Invalid draft evidence request" });
  if (!owner) throw createError({ statusCode: 404, message: "Draft not found" });
  const { drafts } = await handleDraftsProvenance(app, {
    userId: user.userId,
    projectId,
    body: {
      owner: draftOwnerKey(owner),
      drafts: [{ draftId: room.draftId, documentId: getRouterParam(event, "documentId") ?? "" }],
    },
  });
  const evidence = drafts[room.draftId];
  if (!evidence) throw createError({ statusCode: 404, message: "Draft not found" });
  return evidence;
});
