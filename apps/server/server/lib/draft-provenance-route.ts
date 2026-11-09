/** Authenticated draft evidence read; a transport address never supplies file authority. */

import type { BranchId } from "@meridian/contracts";
import type { DraftProvenanceResponse } from "@meridian/contracts/branches";
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import { z } from "zod";
import type { AppServices } from "./app.js";
import { requireBranchAccess, selectBranchRouteServices } from "./branch-review-route.js";
import { requireFileGrant } from "./file-access-http.js";

const clock = z.number().int().nonnegative().safe();
const request = z.strictObject({
  roomName: z.string().max(200),
  writerRanges: z.array(
    z
      .tuple([clock, clock, clock.positive()])
      .refine(([, start, length]) => Number.isSafeInteger(start + length)),
  ),
});
export async function handleDraftProvenance(
  app: AppServices,
  input: {
    userId: UserId;
    projectId: ProjectId;
    branchId: BranchId;
    documentId: DocumentId;
    body: unknown;
  },
): Promise<DraftProvenanceResponse> {
  const { owner } = await requireBranchAccess(selectBranchRouteServices(app), input);
  if (!owner) throw createError({ statusCode: 404, message: "Draft not found" });
  await requireFileGrant(
    app.fileAccess,
    input.userId,
    { kind: "draft", documentId: input.documentId, owner },
    "read",
  );
  const parsed = request.safeParse(input.body);
  const room = parsed.success ? parseYjsRoomName(parsed.data.roomName) : null;
  if (!parsed.success || room?.kind !== "draft")
    throw createError({ statusCode: 400, message: "Invalid draft evidence request" });
  const evidence = await app.documentSync.readDraftProvenance({
    draftId: room.draftId,
    owner,
    documentId: input.documentId,
    writerRanges: parsed.data.writerRanges,
  });
  if (!evidence) throw createError({ statusCode: 404, message: "Draft not found" });
  return evidence;
}
