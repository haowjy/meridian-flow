import { t } from "@lingui/core/macro";
import type { LeftOutWhy } from "@meridian/contracts/commands";
import type { TreeFact } from "./tree-undo";

/**
 * Why a tree change an Undo left stayed, named as the writer saw it land. The review row, Ctrl+Z
 * and the chat card's Undo all say it with this sentence.
 */
export function treeLeftSentence(fact: TreeFact, why: LeftOutWhy): string {
  const change =
    fact.did === "moved"
      ? t`The move`
      : fact.did === "renamed"
        ? t`The rename`
        : fact.did === "restored"
          ? t`The restore from Trash`
          : fact.did === "deleted"
            ? t`The delete`
            : fact.did === "created"
              ? fact.folder
                ? t`The new folder`
                : t`The new document`
              : fact.folder
                ? t`The change to this folder`
                : t`The change to this document`;
  switch (why) {
    case "purged":
      return t`${change} can no longer be taken back.`;
    case "has_text":
      return t`${change} stayed: it has writing in it since.`;
    case "closed":
      return t`${change} stayed: its Work is closed.`;
    case "would_loop":
    case "after_press":
    case "needs":
    case "changed_since":
    case "already":
      return t`${change} stayed: it was changed since.`;
    default:
      return why satisfies never;
  }
}
