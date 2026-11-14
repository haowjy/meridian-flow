/**
 * List the project's Discard entries in Trash: each Discard (or restore that swapped a draft
 * out) that still has a text draft closed under it or tree records no restore has taken.
 */
import type { ListDiscardEntriesResponse } from "@meridian/contracts/branches";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { discardedTree } from "../../../../../../domains/context/index.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event): Promise<ListDiscardEntriesResponse> => {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const lists = [
    { kind: "project", projectId },
    { kind: "account", userId: user.userId },
  ] as const;
  const entries: ListDiscardEntriesResponse["entries"] = [];
  for (const entry of await app.documentSync.draftReview.listDiscards(projectId)) {
    const halves = await Promise.all(
      lists.map((list) => discardedTree(app.treeLists, list, entry.commandId)),
    );
    const taken = halves.filter((half) => !half.restored);
    const records = taken.reduce((sum, half) => sum + half.records.length, 0);
    if (entry.drafts.length === 0 && records === 0) continue;
    entries.push({
      ...entry,
      tree: { records, created: taken.flatMap((half) => half.created) },
    });
  }
  return { entries };
});
