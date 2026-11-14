import { t } from "@lingui/core/macro";
import type { TreeActionRefusal } from "@/core/project-tree/tree-actions";

/** What the writer can do about a tree action that did not append; `what` is the thing acted on. */
export function treeActionMessage(reason: TreeActionRefusal, what: "folder" | "file"): string {
  switch (reason) {
    case "name":
      return t`This name can't be used. Try a different one.`;
    case "missing":
      return what === "folder"
        ? t`This folder is no longer there. Refresh and try again.`
        : t`This file is no longer there. Refresh and try again.`;
    case "read-only":
      return t`This project is read-only, so nothing can be changed here.`;
    case "archived":
      return t`This Work is archived. Unarchive it to change its tree.`;
    case "deleted":
      return t`This Work is deleted. Restore it to change its tree.`;
    case "denied":
      return t`You don't have access to change this.`;
    case "no-list":
      return t`Still loading. Try again in a moment.`;
  }
}
