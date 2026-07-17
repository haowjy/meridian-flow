/** Writer-facing location of an open tab, shared by the identity bar's surfaces. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

import type { ContextTab } from "@/client/stores";
import { parentPath as parentFolderPath } from "./file-suggestions";

export type TabLocation = {
  scheme: ProjectContextTreeScheme;
  /** Tree-style parent folder path: `/` for a scheme root. */
  parentPath: string;
  folders: string[];
  leaf: string;
  provisional: boolean;
  /** Whether the identity bar's typed surfaces may edit this tab. */
  editable: boolean;
  workId?: string;
  /** Server path (leading slash), or null for a not-yet-materialized tab. */
  path: string | null;
};

/** A `new` tab has no server path yet — it lives in Scratch by construction,
 *  so the bar can say so before the server allocates anything. */
export function tabLocation(tab: ContextTab): TabLocation {
  if (tab.kind === "new") {
    return {
      scheme: "scratch",
      parentPath: "/",
      folders: [],
      leaf: tab.name,
      provisional: true,
      editable: true,
      path: null,
    };
  }
  const segments = tab.path.split("/").filter(Boolean);
  return {
    scheme: tab.scheme,
    parentPath: parentFolderPath(tab.path),
    folders: segments.slice(0, -1),
    leaf: tab.name,
    provisional: tab.kind === "tracked" && Boolean(tab.provisionalName),
    editable: tab.kind === "tracked",
    workId: tab.workId,
    path: tab.path,
  };
}
