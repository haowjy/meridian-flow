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
  const listed = await app.documentSync.draftReview.listDiscards(projectId);
  // An Un-Apply has no tree half to read.
  const commands = listed.flatMap((entry) => (entry.kind === "unapply" ? [] : [entry.commandId]));
  const halves = await Promise.all(
    lists.map((list) => discardedTree(app.treeLists, list, commands)),
  );
  const entries: ListDiscardEntriesResponse["entries"] = [];
  listed.forEach((entry) => {
    const at = commands.indexOf(entry.commandId);
    const taken = halves.flatMap((half) => (half[at] && !half[at].restored ? [half[at]] : []));
    const records = taken.reduce((sum, half) => sum + half.records.length, 0);
    if (entry.drafts.length === 0 && records === 0) return;
    const nodes = new Set(taken.flatMap((half) => half.records.map((record) => record.node)));
    entries.push({
      ...entry,
      tree: { records, nodes: [...nodes], created: taken.flatMap((half) => half.created) },
    });
  });
  return { entries };
});
