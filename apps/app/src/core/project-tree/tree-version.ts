import type { WorkLifecycleState } from "@meridian/contracts/works";
import { LIVE, type View } from "@meridian/project-tree";
import { createContext, useContext } from "react";

/** The tree the writer sees and acts on: live, or a Work's (live, then its pending records). */
export type TreeVersion = {
  view: View;
  /** The Work's documents with pending text, which the list cannot see (rule 7). */
  pendingText?: ReadonlySet<string>;
  /** The Work ended: its tree shows, and takes no change until it is unarchived or restored. */
  ended?: "archived" | "deleted";
};

export const LIVE_VERSION: TreeVersion = { view: LIVE };

/** The shell's Live/Draft toggle as a version; live outside a project shell. */
export const TreeVersionContext = createContext<TreeVersion>(LIVE_VERSION);

export const useTreeVersion = (): TreeVersion => useContext(TreeVersionContext);

/**
 * A Work's tree: live, then the branch's pending records, keeping what it holds text on. One
 * value per branch while what it holds is unchanged, whoever reads it (the shell, a review's
 * route, an Apply's Undo step): the list replays a view once per change only for one set.
 */
export function draftTreeVersion(
  branchId: string,
  rows: readonly { documentId: string; hasDraft: boolean }[] | null,
  lifecycle: WorkLifecycleState = "active",
): TreeVersion {
  const pendingText = new Set(rows?.flatMap((row) => (row.hasDraft ? [row.documentId] : [])));
  const ended = lifecycle !== "active" ? lifecycle : undefined;
  const held = draftVersions.get(branchId);
  if (held && held.ended === ended && sameSet(held.pendingText, pendingText)) return held;
  const version: TreeVersion = {
    view: { draft: branchId },
    pendingText,
    ...(ended ? { ended } : {}),
  };
  draftVersions.set(branchId, version);
  return version;
}
const draftVersions = new Map<string, TreeVersion>();

function sameSet(a: ReadonlySet<string> | undefined, b: ReadonlySet<string>): boolean {
  if (a?.size !== b.size) return false;
  for (const id of b) if (!a.has(id)) return false;
  return true;
}
