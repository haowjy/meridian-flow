/**
 * A model edit's write: read, plan, lower and append in one critical section under the lock the
 * append takes (the seam's Work locks, a drafted write's branch, then the document's lock), inside
 * the command transaction `modelEdits().run` opened. Planning under the lock is what keeps a writer's undo from landing between a plan and
 * its append, so the receipt never claims text a tombstone already covers.
 */
import {
  parseDocumentAddress,
  type WriteCommand,
  type WriteOutcome,
} from "@meridian/agent-edit/integration";
import { type DraftOwner, draftOwnerKey, type LinkView, type ThreadId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import { approveBranchWriteJoin } from "../../../shared/branch-write-join.js";
import { testHook } from "../../../shared/test-hooks.js";
import { runWithEditGrants } from "../../file-policy/edit-confirmation.js";
import { agentProject, type FileAccess, type FileGrant } from "../../file-policy/index.js";
import type { LiveAgentEditCore, RoutedWriteOutcome } from "./agent-edit-cores.js";
import type { AgentEditRouter } from "./agent-edit-router.js";
import type { WorkViews } from "./agent-edit-runtime.js";
import type { Branches } from "./branches.js";
import { runWithInversePrincipal } from "./inverse-principal.js";
import { runInLockedWrite } from "./locked-write.js";
import type { ModelEdits, ModelEditWriteContext } from "./model-edit.js";

/** A write's context without its grant, which the router takes apart. */
type GivenContext = Omit<ModelEditWriteContext, "grant">;

/** What a model edit's write needs from the rest of collab; the seams here are the adapters'. */
export type ModelEditWriteDeps = {
  liveCore: LiveAgentEditCore;
  /** A Work's view of Live: a drafted write goes into Live as the Work's suggestions. */
  workView: WorkViews;
  branches: Pick<Branches, "ensureActiveForWrite" | "viewForOwner">;
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  /** The seam a live journal append enters first: the grants' Works, then the document's lock. */
  enterLiveSeam(documentId: DocumentId): Promise<void>;
  /** A drafted write's first locks: the grants' Works and lineages, then their confirmation. */
  enterDraftSeam(): Promise<void>;
  /**
   * The document exists only in this owner's Work (its create is pending there). Its text is
   * plain: the pending create is its whole pending state.
   */
  existsOnlyInWork(documentId: DocumentId, owner: DraftOwner): Promise<boolean>;
};

export function createModelEditWriter(deps: ModelEditWriteDeps): ModelEdits["write"] {
  async function live(
    command: WriteCommand,
    given: GivenContext,
    documentId: DocumentId | null,
  ): Promise<WriteOutcome> {
    if (documentId) {
      await deps.enterLiveSeam(documentId);
      await testHook("command.afterLock");
    }
    return deps.liveCore.write(command, { ...given, linkView: { kind: "live" } });
  }

  /**
   * A drafted write: Live's door, as that Work's suggestions. The Work's branch is opened first:
   * its review list, counts and press are the branch's.
   */
  async function suggest(
    command: WriteCommand,
    given: GivenContext,
    documentId: DocumentId | null,
    grant: FileGrant<"edit">,
    owner: DraftOwner,
  ): Promise<WriteOutcome> {
    await deps.enterDraftSeam();
    approveBranchWriteJoin();
    const branch = await deps.branches.ensureActiveForWrite({
      owner,
      // The thread's project, not the file's: a home document has none.
      projectId: agentProject(grant),
      threadId: (given.threadId as ThreadId | undefined) ?? null,
      userId: grant.principal.accountId,
    });
    if (documentId) {
      await deps.enterLiveSeam(documentId);
      await testHook("command.afterLock");
    }
    const turn =
      given.turnId ?? (given.actor?.kind === "agent" ? given.actor.turnId : null) ?? null;
    const work = draftOwnerKey(owner);
    const core =
      documentId && (await deps.existsOnlyInWork(documentId, owner))
        ? deps.workView.onlyIn(work)
        : deps.workView.core(work, { chat: given.threadId ?? null, turn, by: "agent" });
    return core.write(command, { ...given, linkView: { kind: "branch", branchId: branch.id } });
  }

  return (command, routed: ModelEditWriteContext): Promise<RoutedWriteOutcome> => {
    const { grant, ...given } = routed;
    const documentId = documentIdFromCommand(command);
    return runInLockedWrite(async () => {
      // An inverse takes its own locks in the turn-inverse service. A drafted one reads its echo
      // in the Work's view, where the suggestions it took back show.
      if (command.command === "undo" || command.command === "revert") {
        const drafted = grant.destination.kind === "live" ? null : grant.destination.owner;
        const linkView: LinkView = drafted
          ? await deps.branches.viewForOwner(drafted)
          : { kind: "live" };
        const core = drafted
          ? deps.workView.core(draftOwnerKey(drafted), {
              chat: given.threadId ?? null,
              turn: given.turnId ?? null,
              by: "agent",
            })
          : deps.liveCore;
        return runWithInversePrincipal(grant.principal, () =>
          core.write(command, { ...given, linkView }),
        );
      }
      const confirmed = await runWithEditGrants(deps.fileAccess, [grant], () =>
        grant.destination.kind === "live"
          ? live(command, given, documentId)
          : suggest(command, given, documentId, grant, grant.destination.owner),
      );
      if (!confirmed.ok) throw confirmed.refusal;
      return confirmed.value;
    });
  };
}

function documentIdFromCommand(command: { file: string; documentId?: string }): DocumentId | null {
  const address = parseDocumentAddress(command.file, command.documentId);
  return address.ok ? (address.documentId as DocumentId) : null;
}

/** A read inside a model edit's command: the locked section's rules, so it pulls nothing. */
export function createModelEditRead(read: AgentEditRouter["read"]): ModelEdits["read"] {
  return (command, context) => runInLockedWrite(() => read(command, context));
}
