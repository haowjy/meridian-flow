/**
 * The server's Apply of an owner's branch items that a check passed: the writer's Apply (one
 * command, one Undo step, the same locks and provenance), with the cut frozen from the drafts
 * as they are now. Nothing else applies: an item the selection leaves out stays pending.
 */
import type { BranchId, CommandId, DraftOwner, ProjectId, UserId } from "@meridian/contracts";
import type { ApplyItemsClick } from "@meridian/contracts/branches";
import type * as Y from "yjs";
import type { CommandEnvelope } from "../../../shared/commands/command-record.js";
import { commandDigest } from "../../../shared/commands/command-record.js";
import { type ApplyGate, ApplyHeld, wholeDraftCut } from "./apply-click.js";
import type { DraftReviewItem } from "./branch-review-items.js";

export type AutoApplyResult =
  /** The command applied these items. */
  | { status: "applied"; documentIds: string[] }
  /** The gate said no: nothing changed and the drafts stay pending. */
  | { status: "held" }
  /** No selected item had anything to apply, or Apply refused. */
  | { status: "nothing" };

export function createBranchAutoApply(input: {
  items(owner: DraftOwner): Promise<{ branchId: BranchId | null; items: DraftReviewItem[] }>;
  /** A private copy of a draft's committed replica, destroyed by the caller. */
  copyDraft(draftId: string): Promise<{ doc: Y.Doc }>;
  apply(
    input: { branchId: BranchId; request: ApplyItemsClick; envelope: CommandEnvelope },
    gate?: ApplyGate,
  ): Promise<{ status: string }>;
}) {
  return async function autoApply(command: {
    owner: DraftOwner;
    accountId: UserId;
    projectId: ProjectId;
    /** The id the Apply command keeps; a resend answers the first outcome. */
    commandId: CommandId;
    select(item: DraftReviewItem): boolean;
    gate?: ApplyGate;
  }): Promise<AutoApplyResult> {
    const { branchId, items } = await input.items(command.owner);
    if (!branchId) return { status: "nothing" };
    const cuts: ApplyItemsClick["items"] = [];
    for (const item of items.filter(command.select)) {
      let text: NonNullable<ApplyItemsClick["items"][number]["text"]> | undefined;
      if (item.draftId) {
        const { doc } = await input.copyDraft(item.draftId);
        try {
          const cut = wholeDraftCut(doc);
          if (cut) text = { draftId: item.draftId, ...cut };
        } finally {
          doc.destroy();
        }
      }
      const tree = item.tree ? { revision: item.tree.revision } : undefined;
      if (text || tree)
        cuts.push({ node: item.documentId, ...(tree ? { tree } : {}), ...(text ? { text } : {}) });
    }
    if (cuts.length === 0) return { status: "nothing" };
    const request: ApplyItemsClick = { commandId: command.commandId, items: cuts };
    const envelope: CommandEnvelope = {
      commandId: command.commandId,
      accountId: command.accountId,
      projectId: command.projectId,
      kind: "apply",
      digest: commandDigest({
        accountId: command.accountId,
        projectId: command.projectId,
        branchId,
        kind: "apply",
        selectors: { branchId },
        body: request,
      }),
    };
    try {
      const answer = await input.apply({ branchId, request, envelope }, command.gate);
      return answer.status === "applied"
        ? { status: "applied", documentIds: cuts.map((cut) => cut.node) }
        : { status: "nothing" };
    } catch (cause) {
      if (cause instanceof ApplyHeld) return { status: "held" };
      throw cause;
    }
  };
}
