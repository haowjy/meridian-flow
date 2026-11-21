import type { WorkLifecycleState } from "@meridian/contracts/works";
import { LIVE, type View } from "@meridian/project-tree";
import { createContext, useContext } from "react";

/** The tree the writer sees and acts on: live, or a Work's (live, then its pending records). */
export type TreeVersion = {
  view: View;
  /** The Work ended: its tree shows, and takes no change until it is unarchived or restored. */
  ended?: "archived" | "deleted";
};

export const LIVE_VERSION: TreeVersion = { view: LIVE };

/** The shell's Live/Draft toggle as a version; live outside a project shell. */
export const TreeVersionContext = createContext<TreeVersion>(LIVE_VERSION);

export const useTreeVersion = (): TreeVersion => useContext(TreeVersionContext);

/**
 * A Work's tree: live, then the draft's pending records. One value per draft and lifecycle,
 * whoever reads it (the shell, a review's route, an Apply's Undo step).
 */
export function draftTreeVersion(
  draftId: string,
  lifecycle: WorkLifecycleState = "active",
): TreeVersion {
  const ended = lifecycle !== "active" ? lifecycle : undefined;
  const held = draftVersions.get(draftId);
  if (held && held.ended === ended) return held;
  const version: TreeVersion = { view: { draft: draftId }, ...(ended ? { ended } : {}) };
  draftVersions.set(draftId, version);
  return version;
}
const draftVersions = new Map<string, TreeVersion>();
