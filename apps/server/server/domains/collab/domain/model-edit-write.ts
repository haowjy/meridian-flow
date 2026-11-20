/**
 * A model edit's write: read, plan, lower and append in one critical section under the lock the
 * append takes (live: the seam's Work locks and the document's lock; a Work draft: the Work, its
 * branch, its draft, then the draft row), inside the command transaction `modelEdits().run`
 * opened. Planning under the lock is what keeps a writer's undo from landing between a plan and
 * its append, so the receipt never claims text a tombstone already covers.
 */
import {
  type AgentEditCore,
  type ObservationFrontier,
  parseDocumentAddress,
  type WriteCommand,
  type WriteContext,
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
import type { DraftSnapshot } from "./draft-store.js";
import { runWithInversePrincipal } from "./inverse-principal.js";
import { runInLockedWrite } from "./locked-write.js";
import type { ModelEdits, ModelEditWriteContext } from "./model-edit.js";
import { projectedFrontiers } from "./seed-frontier.js";

/** A write's context without its grant, which the router takes apart. */
type GivenContext = Omit<ModelEditWriteContext, "grant">;

/** What a model edit's write needs from the rest of collab; the seams here are the adapters'. */
export type ModelEditWriteDeps = {
  liveCore: LiveAgentEditCore;
  /** The thread's core over Work drafts. */
  threadCore(threadId: ThreadId): AgentEditCore;
  branches: Pick<Branches, "ensureActiveForWrite" | "viewForOwner">;
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  /** The seam a live journal append enters first: the grants' Works, then the document's lock. */
  enterLiveSeam(documentId: DocumentId): Promise<void>;
  /** A drafted write's first locks: the grants' Works and lineages, then their confirmation. */
  enterDraftSeam(): Promise<void>;
  /** The branch's draft of the document, made from live text when absent. */
  ensureWorkDraft(input: {
    documentId: DocumentId;
    branchId: string;
    /** The live cut the model last saw, which a new draft seeds from. */
    seen: ObservationFrontier | null;
  }): Promise<DraftSnapshot>;
  /** Row-locks the draft: the append's own lock, taken before the room is read. */
  lockDraft(draftId: string): Promise<void>;
  /** The live room's current name for the document, or null when it has no addressable authority. */
  liveRoomOf(documentId: DocumentId): Promise<string | null>;
  /** A draft seeded from an older cut is behind Live: runs once the command's transaction commits. */
  draftBehindLive(documentId: DocumentId): void;
  /** Suggestion mode (prototype): a drafted write goes into Live as the Work's suggestions. */
  workView?: WorkViews | null;
};

export function createModelEditWriter(deps: ModelEditWriteDeps): ModelEdits["write"] {
  function threadCoreFor(given: WriteContext): AgentEditCore {
    if (!given.threadId) throw new Error("A drafted model edit names its thread");
    return deps.threadCore(given.threadId as ThreadId);
  }

  async function live(
    command: WriteCommand,
    given: GivenContext,
    documentId: DocumentId | null,
  ): Promise<WriteOutcome> {
    if (documentId) {
      await deps.enterLiveSeam(documentId);
      await testHook("command.afterLock");
    }
    const outcome = await deps.liveCore.write(command, {
      ...given,
      linkView: { kind: "live" },
      documentVersion: "live",
    });
    return outcome;
  }

  async function draft(
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
    const linkView: LinkView = { kind: "branch", branchId: branch.id };
    // An unaddressable file has no draft: the core answers it as the invalid write it is.
    if (!documentId)
      return threadCoreFor(given).write(command, { ...given, linkView, documentVersion: "draft" });
    const liveRoom = await deps.liveRoomOf(documentId);
    const seen = liveRoom ? ((await given.frontiers?.planning?.(liveRoom)) ?? null) : null;
    const workDraft = await deps.ensureWorkDraft({ documentId, branchId: branch.id, seen });
    await deps.lockDraft(workDraft.draftId);
    await testHook("command.afterLock");
    const outcome = await threadCoreFor(given).write(command, {
      ...given,
      linkView,
      documentVersion: "draft",
      workDraftId: workDraft.draftId,
      frontiers: projectedFrontiers(given.frontiers, [
        { workDraftId: workDraft.draftId, seed: workDraft.seed },
      ]),
    });
    // A draft seeded from an older cut is behind live: the pull brings the writer's typing in.
    if (seen && !workDraft.hasEffect) deps.draftBehindLive(documentId);
    return outcome;
  }

  /** A drafted write in suggestion mode: Live's door, as that Work's suggestions. */
  async function suggest(
    command: WriteCommand,
    given: GivenContext,
    documentId: DocumentId | null,
    owner: DraftOwner,
    workView: WorkViews,
  ): Promise<WriteOutcome> {
    if (documentId) {
      await deps.enterLiveSeam(documentId);
      await testHook("command.afterLock");
    }
    const work = draftOwnerKey(owner);
    const turn =
      given.turnId ?? (given.actor?.kind === "agent" ? given.actor.turnId : null) ?? null;
    return workView.core(work, { chat: given.threadId ?? null, turn, by: "agent" }).write(command, {
      ...given,
      linkView: { kind: "live" },
      documentVersion: "live",
    });
  }

  return (command, routed: ModelEditWriteContext): Promise<RoutedWriteOutcome> => {
    const { grant, ...given } = routed;
    const documentId = documentIdFromCommand(command);
    const inverse = command.command === "undo" || command.command === "revert";
    const workView = deps.workView;
    if (workView && grant.destination.kind === "draft" && !inverse) {
      const owner = grant.destination.owner;
      return runInLockedWrite(async () => {
        const confirmed = await runWithEditGrants(deps.fileAccess, [grant], () =>
          suggest(command, given, documentId, owner, workView),
        );
        if (!confirmed.ok) throw confirmed.refusal;
        return confirmed.value;
      });
    }
    return runInLockedWrite(async () => {
      // An inverse takes its own locks in the turn-inverse service, as it always has.
      if (inverse) {
        const linkView: LinkView =
          grant.destination.kind === "live"
            ? { kind: "live" }
            : await deps.branches.viewForOwner(grant.destination.owner);
        const core = grant.destination.kind === "live" ? deps.liveCore : threadCoreFor(given);
        return runWithInversePrincipal(grant.principal, () =>
          core.write(command, { ...given, linkView, documentVersion: grant.destination.kind }),
        );
      }
      const confirmed = await runWithEditGrants(deps.fileAccess, [grant], () =>
        grant.destination.kind === "live"
          ? live(command, given, documentId)
          : draft(command, given, documentId, grant, grant.destination.owner),
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
