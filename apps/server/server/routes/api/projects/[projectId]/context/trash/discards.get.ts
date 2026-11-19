/**
 * List the project's Discard entries in Trash: each run of Discards, folded into one, that still
 * has text a Restore hasn't ended or tree records no restore has taken.
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
  const commands = listed.map((entry) => entry.commandId);
  const halves = await Promise.all(
    lists.map((list) => discardedTree(app.treeLists, list, commands)),
  );
  type Entry = ListDiscardEntriesResponse["entries"][number];
  /** The documents an entry holds: what a run must share to be one place. */
  const placeOf = (entry: Entry) =>
    [...new Set([...entry.drafts.map((draft) => draft.documentId), ...entry.tree.nodes])]
      .sort()
      .join(",");
  const entries: Entry[] = [];
  // Newest first. A Discard joins the entry of the Discard right after it when that one adjoins it
  // (nothing else of the writer's ran between) and holds the same documents; restoring the entry
  // sends every id.
  let newer: { entry: Entry; adjoins: boolean } | null = null;
  listed.forEach((discarded, at) => {
    const taken = halves.flatMap((half) => (half[at] && !half[at].restored ? [half[at]] : []));
    const records = taken.reduce((sum, half) => sum + half.records.length, 0);
    const above = newer;
    newer = null;
    if (discarded.drafts.length === 0 && records === 0) return;
    const nodes = new Set(taken.flatMap((half) => half.records.map((record) => record.node)));
    const { commandId, accountId: _, adjoinsOlder, ...rest } = discarded;
    const entry: Entry = {
      ...rest,
      commandIds: [commandId],
      tree: { records, nodes: [...nodes], created: taken.flatMap((half) => half.created) },
    };
    if (
      above?.adjoins &&
      above.entry.branchId === entry.branchId &&
      placeOf(above.entry) === placeOf(entry)
    ) {
      above.entry.commandIds.push(commandId);
      above.entry.tree.records += records;
      newer = { entry: above.entry, adjoins: adjoinsOlder };
    } else {
      entries.push(entry);
      newer = { entry, adjoins: adjoinsOlder };
    }
  });
  return { entries };
});
