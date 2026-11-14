import { LIVE, type View } from "@meridian/project-tree";
import { createContext, useContext } from "react";

/** The tree the writer sees and acts on: live, or a Work's (live, then its pending records). */
export type TreeVersion = {
  view: View;
  /** The Work's documents with pending text, which the list cannot see (rule 7). */
  pendingText?: ReadonlySet<string>;
};

export const LIVE_VERSION: TreeVersion = { view: LIVE };

/** The shell's Live/Draft toggle as a version; live outside a project shell. */
export const TreeVersionContext = createContext<TreeVersion>(LIVE_VERSION);

export const useTreeVersion = (): TreeVersion => useContext(TreeVersionContext);
