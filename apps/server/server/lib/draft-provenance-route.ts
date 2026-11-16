/** Authenticated draft evidence read for every room a review holds; a transport address never supplies file authority. */

import type {
  DraftProvenanceResponse,
  DraftsProvenanceResponse,
} from "@meridian/contracts/branches";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import { z } from "zod";
import type { AppServices } from "./app.js";
import { requireListedOwner, selectBranchRouteServices } from "./branch-review-route.js";

const request = z.strictObject({
  owner: z.string().max(200),
  drafts: z
    .array(z.strictObject({ draftId: z.string().min(1).max(128), documentId: z.string().uuid() }))
    .max(2000),
});

/**
 * The evidence of the owner's drafts the request names, one read for all of them. A draft the
 * writer can't read in the owner's view, or that is no longer the owner's active draft of its
 * document, is left out: its room asks again when it reconnects or its roots change.
 */
export async function handleDraftsProvenance(
  app: AppServices,
  input: { userId: UserId; projectId: ProjectId; body: unknown },
): Promise<DraftsProvenanceResponse> {
  const parsed = request.safeParse(input.body);
  if (!parsed.success)
    throw createError({ statusCode: 400, message: "Invalid draft evidence request" });
  const owner = await requireListedOwner(selectBranchRouteServices(app), {
    projectId: input.projectId,
    owner: parsed.data.owner,
    userId: input.userId,
  });
  const readable = await app.fileAccess.listAccess(
    { accountId: input.userId },
    parsed.data.drafts.map((draft) => draft.documentId as DocumentId),
    { destination: { kind: "draft", owner, ownerHandle: null } },
  );
  const evidence = await app.documentSync.readDraftProvenance({
    owner,
    drafts: parsed.data.drafts
      .filter((draft) => readable.has(draft.documentId as DocumentId))
      .map((draft) => ({ draftId: draft.draftId, documentId: draft.documentId as DocumentId })),
  });
  const drafts: Record<string, DraftProvenanceResponse> = {};
  for (const [draftId, answer] of evidence) drafts[draftId] = answer;
  return { drafts };
}
