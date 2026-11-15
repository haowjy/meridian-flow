/**
 * The server's Apply of the owner's branch items an AI write produced, in two steps so that what
 * is checked is what is applied: `freeze` captures the writer's click for those items (draft ids,
 * frozen snapshots, tree revisions), and says what live plus exactly that click would show;
 * `apply` then dispatches that same click. A write that lands in a draft after the freeze is not
 * in the click, and gets its own check. Nothing else applies: an item the selection leaves out
 * stays pending.
 */
import type { BranchId, CommandId, DraftOwner, ProjectId, UserId } from "@meridian/contracts";
import type { ApplyItemsClick } from "@meridian/contracts/branches";
import type * as Y from "yjs";
import type { CommandEnvelope } from "../../../shared/commands/command-record.js";
import { commandDigest } from "../../../shared/commands/command-record.js";
import { wholeDraftCut } from "./apply-click.js";
import type { DraftReviewItem } from "./branch-review-items.js";

/** What live plus the frozen click shows: the branch rows it carries and each draft's text at its cut. */
export interface FrozenCut {
  branchId: BranchId;
  /** Ids of the nodes whose branch rows the click carries. */
  nodes: string[];
  /** The markdown of each frozen draft, by document id. */
  texts: Record<string, string>;
}

export interface FrozenApply {
  cut: FrozenCut;
  /** Dispatches the frozen click: whether the Apply took it. */
  apply(): Promise<"applied" | "nothing">;
}

export function createBranchAutoApply(input: {
  items(owner: DraftOwner): Promise<{ branchId: BranchId | null; items: DraftReviewItem[] }>;
  /** The folders the branch has a row on, with the address each has in the branch's view. */
  folders(branchId: BranchId): Promise<Array<{ id: string; revision: string; uri: string | null }>>;
  /** A private copy of a draft's committed replica, destroyed by the caller. */
  copyDraft(draftId: string): Promise<{ doc: Y.Doc }>;
  /** The markdown a draft's copy shows in the owner's branch view. */
  serialize(documentId: string, doc: Y.Doc, owner: DraftOwner): Promise<string>;
  apply(input: {
    branchId: BranchId;
    request: ApplyItemsClick;
    envelope: CommandEnvelope;
  }): Promise<{ status: string }>;
}) {
  return async function freezeApply(command: {
    owner: DraftOwner;
    accountId: UserId;
    projectId: ProjectId;
    /** The id the Apply command keeps; a resend answers the first outcome. */
    commandId: CommandId;
    /** Whether a pending item, or a folder the branch has a row on, is part of what applies. */
    select(item: Pick<DraftReviewItem, "path" | "tree">): boolean;
  }): Promise<FrozenApply | null> {
    const { branchId, items } = await input.items(command.owner);
    if (!branchId) return null;
    const texts: Record<string, string> = {};
    const cuts: ApplyItemsClick["items"] = [];
    const selected = items.filter(command.select);
    for (const item of selected) {
      let text: NonNullable<ApplyItemsClick["items"][number]["text"]> | undefined;
      if (item.draftId) {
        const { doc } = await input.copyDraft(item.draftId);
        try {
          const cut = wholeDraftCut(doc);
          if (cut) {
            text = { draftId: item.draftId, ...cut };
            texts[item.documentId] = await input.serialize(item.documentId, doc, command.owner);
          }
        } finally {
          doc.destroy();
        }
      }
      const tree = item.tree ? { revision: item.tree.revision } : undefined;
      if (text || tree)
        cuts.push({ node: item.documentId, ...(tree ? { tree } : {}), ...(text ? { text } : {}) });
    }
    // A folder the selected files sit in, or one made alone, applies in the same cut.
    for (const folder of await input.folders(branchId))
      if (command.select({ path: folder.uri, tree: null }))
        cuts.push({ node: folder.id, tree: { revision: folder.revision } });
    if (cuts.length === 0) return null;
    // An item live has in Trash is Applied as a restore, which the writer's click says it knew.
    const request: ApplyItemsClick = {
      commandId: command.commandId,
      items: cuts,
      ...(selected.some((item) => item.deletedLive) ? { restore: true as const } : {}),
    };
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
    return {
      cut: { branchId, nodes: cuts.map((cut) => cut.node), texts },
      async apply() {
        const answer = await input.apply({ branchId, request, envelope });
        return answer.status === "applied" ? "applied" : "nothing";
      },
    };
  };
}
