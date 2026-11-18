/**
 * A model edit's write: read, plan, lower and append in one critical section under the lock the
 * append takes (live: the seam's Work locks and the document's lock; a Work draft: the Work, its
 * branch, its draft, then the draft row), inside the command transaction `modelEdits().run`
 * opened. Planning under the lock is what keeps a writer's undo from landing between a plan and
 * its append, so the receipt never claims text a tombstone already covers.
 */
import {
  type AgentEditCore,
  modelResult,
  type ObservationFrontier,
  parseDocumentAddress,
  returnedWriteResult,
  splitDocumentFile,
  type WriteCommand,
  type WriteContext,
  type WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { DraftOwner, LinkView, ThreadId } from "@meridian/contracts";
import type { ReturnedWhy } from "@meridian/contracts/commands";
import type { DocumentId } from "@meridian/contracts/runtime";
import { approveBranchWriteJoin } from "../../../shared/branch-write-join.js";
import { testHook } from "../../../shared/test-hooks.js";
import { runWithEditGrants } from "../../file-policy/edit-confirmation.js";
import { agentProject, type FileAccess, type FileGrant } from "../../file-policy/index.js";
import type { LiveAgentEditCore, RoutedWriteOutcome } from "./agent-edit-cores.js";
import type { AgentEditRouter } from "./agent-edit-router.js";
import type { Branches } from "./branches.js";
import type { DraftSnapshot } from "./draft-store.js";
import { runWithInversePrincipal } from "./inverse-principal.js";
import { runInLockedWrite } from "./locked-write.js";
import type { ModelEdits, ModelEditWriteContext } from "./model-edit.js";
import type { ModelEvidence } from "./model-evidence.js";
import { draftRoom, supersededRoom } from "./observation-rooms.js";
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
  /** Every Work draft of the document, any status, and the live room's current name. */
  roomsOf(documentId: DocumentId): Promise<{
    liveRoom: string | null;
    drafts: readonly {
      draftId: string;
      status: string;
      closedAs: "discarded" | "replaced" | "document_removed" | null;
    }[];
  }>;
  /** The document as this chat reads it now, which a returned edit shows: a read never opens a draft. */
  read: ModelEdits["read"];
  /** What the model last saw, among the blocks the runtime names. */
  evidence: Pick<ModelEvidence, "latestRoom">;
  /** Runs once the command's transaction commits. */
  afterLiveCommit(documentId: DocumentId): void;
};

export function createModelEditWriter(deps: ModelEditWriteDeps): ModelEdits["write"] {
  /**
   * How the draft the model last saw closed, when it has: that edit was planned on text that is
   * no longer a draft. A Discard closed it as discarded, a Restore's swap as replaced; the
   * document's removal or an Apply of its delete as a removed document. After the purge the
   * model's observation is the document's superseded room: the draft and its cut are gone, so
   * `draftId` is null and the write takes the no-view rule.
   */
  async function closedDraftSeen(
    documentId: DocumentId,
    { liveRoom: live, drafts }: Awaited<ReturnType<ModelEditWriteDeps["roomsOf"]>>,
    creditedBlockIds: readonly string[] | undefined,
  ): Promise<{
    draftId: string | null;
    closedAs: "discarded" | "replaced" | "purged" | "document_removed";
  } | null> {
    if (!creditedBlockIds) return null;
    const purged = supersededRoom(documentId);
    const latest = await deps.evidence.latestRoom(
      [...(live ? [live] : []), purged, ...drafts.map((draft) => draftRoom(draft.draftId))],
      creditedBlockIds,
    );
    if (latest === purged) return { draftId: null, closedAs: "purged" };
    const seen = drafts.find((draft) => draftRoom(draft.draftId) === latest);
    return seen?.status === "closed"
      ? { draftId: seen.draftId, closedAs: seen.closedAs ?? "document_removed" }
      : null;
  }

  /**
   * An edit that changed nothing, answered with the document as this chat reads it now. The text
   * and its evidence are the read's, so the model's next write plans on it and lands. A removed
   * document shows no text: it has none for this chat.
   */
  async function returnedEdit(
    command: WriteCommand,
    given: GivenContext,
    grant: FileGrant<"edit">,
    why: ReturnedWhy,
  ): Promise<WriteOutcome> {
    const path = splitDocumentFile(command.file).filePath;
    const returned = returnedWriteResult(why);
    const current =
      why === "document_removed"
        ? null
        : await deps.read(
            {
              file: command.file,
              ...(command.documentId ? { documentId: command.documentId } : {}),
            },
            // A plain read: the reply's own writes went to the draft that closed, which this
            // text does not hold.
            {
              ...given,
              grant,
              ...(given.frontiers?.recording
                ? { frontiers: { recording: given.frontiers.recording } }
                : { frontiers: undefined }),
            },
          );
    const shown = current && !current.isError ? current : null;
    return {
      status: "returned",
      isError: false,
      revision: shown?.revision ?? null,
      command: command.command,
      result: modelResult({
        command: command.command,
        status: "returned",
        payload: {
          path,
          ...returned.model,
          // The caller names the version the edit would have changed; the read's own would repeat it.
          ...(shown?.result.read
            ? {
                read: {
                  format: shown.result.read.format,
                  documentBlocks: shown.result.read.documentBlocks,
                },
              }
            : {}),
          ...(shown?.result.blocks ? { blocks: shown.result.blocks } : {}),
        },
      }),
      ...(shown?.showing ? { showing: shown.showing } : {}),
      ...(shown?.frontier ? { frontier: shown.frontier } : {}),
    };
  }

  /** The model is told its earlier draft closed and that this edit opened a new one. */
  function withNewDraftNote(
    outcome: WriteOutcome,
    closed: "discarded" | "replaced" | "purged",
  ): WriteOutcome {
    const earlier = {
      discarded: "Your earlier draft of this file was discarded by the writer.",
      replaced: "Your earlier draft of this file was replaced when the writer restored another.",
      purged:
        "Your earlier draft of this file was closed by the writer and has since been cleared.",
    }[closed];
    const note = `${earlier} This edit opened a new draft.`;
    const { message } = outcome.result;
    return {
      ...outcome,
      result: { ...outcome.result, message: message ? `${note}\n${message}` : note },
    };
  }

  function threadCoreFor(given: WriteContext): AgentEditCore {
    if (!given.threadId) throw new Error("A drafted model edit names its thread");
    return deps.threadCore(given.threadId as ThreadId);
  }

  async function live(
    command: WriteCommand,
    given: GivenContext,
    documentId: DocumentId | null,
    grant: FileGrant<"edit">,
  ): Promise<WriteOutcome> {
    if (documentId) {
      await deps.enterLiveSeam(documentId);
      await testHook("command.afterLock");
      const closed = await closedDraftSeen(
        documentId,
        await deps.roomsOf(documentId),
        given.creditedBlockIds,
      );
      if (closed?.closedAs === "document_removed")
        return returnedEdit(command, given, grant, "document_removed");
    }
    const outcome = await deps.liveCore.write(command, {
      ...given,
      linkView: { kind: "live" },
      documentVersion: "live",
    });
    if (!outcome.isError && documentId) deps.afterLiveCommit(documentId);
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
    // Before anything opens: an edit that is going to be returned makes no branch and no draft.
    const rooms = documentId ? await deps.roomsOf(documentId) : null;
    const closed =
      documentId && rooms ? await closedDraftSeen(documentId, rooms, given.creditedBlockIds) : null;
    if (closed?.closedAs === "document_removed")
      return returnedEdit(command, given, grant, "document_removed");
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
    if (!documentId || !rooms)
      return threadCoreFor(given).write(command, { ...given, linkView, documentVersion: "draft" });
    const { liveRoom } = rooms;
    const seen = liveRoom ? ((await given.frontiers?.planning?.(liveRoom)) ?? null) : null;
    const workDraft = await deps.ensureWorkDraft({ documentId, branchId: branch.id, seen });
    await deps.lockDraft(workDraft.draftId);
    await testHook("command.afterLock");
    const outcome = await threadCoreFor(given).write(command, {
      ...given,
      linkView,
      documentVersion: "draft",
      workDraftId: workDraft.draftId,
      ...(closed ? { supersededWorkDraftId: closed.draftId } : {}),
      frontiers: projectedFrontiers(given.frontiers, [
        { workDraftId: workDraft.draftId, seed: workDraft.seed },
      ]),
    });
    // A draft seeded from an older cut is behind live: the pull brings the writer's typing in.
    if (seen && !workDraft.hasEffect) deps.afterLiveCommit(documentId);
    return closed && !outcome.isError ? withNewDraftNote(outcome, closed.closedAs) : outcome;
  }

  return (command, routed: ModelEditWriteContext): Promise<RoutedWriteOutcome> => {
    const { grant, ...given } = routed;
    const documentId = documentIdFromCommand(command);
    const inverse = command.command === "undo" || command.command === "revert";
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
          ? live(command, given, documentId, grant)
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
