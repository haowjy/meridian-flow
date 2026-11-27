import type { WorkLifecycleState } from "@meridian/contracts/works";
import { LIVE, type View } from "@meridian/project-tree";
import { createContext, useContext } from "react";

export type TreeVersion = {
  view: View;
  ended?: "archived" | "deleted";
};

export const LIVE_VERSION: TreeVersion = { view: LIVE };

export const TreeVersionContext = createContext<TreeVersion>(LIVE_VERSION);

export const useTreeVersion = (): TreeVersion => useContext(TreeVersionContext);

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
