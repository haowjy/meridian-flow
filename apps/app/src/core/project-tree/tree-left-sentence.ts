import { t } from "@lingui/core/macro";
import type { ClosedOwnerWhy, LeftOutWhy } from "@meridian/contracts/commands";
import type { Left, TreeFact } from "./tree-undo";

function changeWords(fact: TreeFact): string {
  return fact.did === "moved"
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
            : fact.name
              ? t`The change to ${fact.name}`
              : fact.folder
                ? t`The change to this folder`
                : t`The change to this document`;
}

/**
 * Why a tree change an Undo left stayed, named as the writer saw it land. The review row, Ctrl+Z
 * and the chat card's Undo all say it with this sentence.
 */
export function treeLeftSentence(fact: TreeFact, why: LeftOutWhy): string {
  const change = changeWords(fact);
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

/**
 * A change an Undo left because taking it back would change a closed owner's notes: the owner says
 * what to do to undo it. The row, the band and the chat card say it with this sentence.
 */
export function heldSentence(
  fact: TreeFact,
  why: ClosedOwnerWhy | undefined,
  owner: string | undefined,
): string {
  const change = changeWords(fact);
  switch (why) {
    case "chat_frozen":
      return owner
        ? t`${change} stayed: ${owner} is in Trash. Restore it to undo this.`
        : t`${change} stayed: its chat is in Trash. Restore it to undo this.`;
    case "work_deleted":
      return owner
        ? t`${change} stayed: ${owner} is deleted. Restore it to undo this.`
        : t`${change} stayed: its Work is deleted. Restore it to undo this.`;
    default:
      return owner
        ? t`${change} stayed: ${owner} is archived. Unarchive it to undo this.`
        : t`${change} stayed: its Work is archived. Unarchive it to undo this.`;
  }
}

/**
 * Why `node`'s change stayed after an Un-Apply: for good (`leftOut`), or held for a closed owner,
 * its tree fact or, when only its text is held, the change to the document. Empty when it went.
 */
export function stayedSentence(left: Left, node: string): string {
  const fact = left.facts.get(node) ?? { did: null, folder: false };
  const text = { did: null, folder: fact.folder, name: fact.name };
  const stayed = left.leftOut.find((one) => one.node === node);
  if (stayed) return treeLeftSentence(stayed.tree ? fact : text, stayed.why);
  const held = left.held.find((one) => one.node === node);
  if (!held) return "";
  return heldSentence(held.tree ? fact : text, held.why, held.owner);
}

/** What an Un-Apply that left something says on one line, away from its rows. */
export function unappliedSentence(left: Left): string {
  const { name } = left;
  const lead = left.taken === "nothing" ? t`Not undone.` : t`Undid part of applying ${name}.`;
  return [lead, ...new Set(left.nodes.map((node) => stayedSentence(left, node)))]
    .filter(Boolean)
    .join(" ");
}
