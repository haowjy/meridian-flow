/**
 * Model undo and redo for the thread-peer pool. A thread's writes to one
 * document can sit in two journals, live and the thread's Work draft (after a
 * D40 "keep" switch, say); each selected write reverses where it landed, under
 * a grant at that destination.
 */
import {
  type AgentEditCore,
  commandSelection,
  type ReversalSelection,
  type ReversalStore,
  type WriteCommand,
  type WriteContext,
  type WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import {
  type FileAccess,
  type FileAccessDenied,
  type FileDestination,
  FileEditRefusedError,
  type FileGrant,
  isFileAccessDenied,
} from "../../file-policy/index.js";
import type { LiveAgentEditCore, RoutedWriteOutcome } from "./agent-edit-cores.js";
import {
  type BranchReversalHistoryReader,
  buildBranchReversalState,
  resolveBranchReversalScope,
} from "./branch-reversal-history.js";
import {
  mergeReversals,
  type ReversalHistory,
  type ReversalSide,
  splitReversal,
} from "./reversal-routing.js";

export type ReversalCommand = Extract<WriteCommand, { command: "undo" | "redo" }>;

export function isReversalCommand(command: WriteCommand): command is ReversalCommand {
  return command.command === "undo" || command.command === "redo";
}

type Histories = { live: ReversalHistory; draft: ReversalHistory | null };

export function createThreadPeerReversals(input: {
  liveUtilityCore: LiveAgentEditCore;
  coreFor(threadId: string | undefined): Promise<AgentEditCore>;
  /** The thread's Work-draft history: its undo and redo reverse drafted writes there. */
  reversalHistory: BranchReversalHistoryReader;
  /** The live journal's history: its undo and redo reverse live writes live. */
  liveHistory: Pick<ReversalStore, "activeWriteSummary" | "readReversals">;
  fileAccess: Pick<FileAccess, "authorizeAt">;
  /** Runs one journal's part on its core: staged in the reply, or committed now. */
  reverseIn(
    core: AgentEditCore,
    command: ReversalCommand,
    documentId: DocumentId | null,
    context: WriteContext,
    grant: FileGrant<"edit">,
  ): Promise<WriteOutcome>;
}) {
  /** Both journals' reversible writes; null for a thread with no drafted history here. */
  async function loadHistories(
    documentId: DocumentId,
    threadId: string | undefined,
  ): Promise<Histories | null> {
    if (!threadId) return null;
    const scope = await resolveBranchReversalScope({
      documentId,
      threadId: threadId as ThreadId,
      ...input.reversalHistory,
    });
    if (!scope) return null;
    const drafted = buildBranchReversalState(threadId as ThreadId, scope.rows);
    const [active, reversals] = await Promise.all([
      input.liveHistory.activeWriteSummary(documentId, threadId),
      input.liveHistory.readReversals(documentId, { threadId }),
    ]);
    return {
      live: { active, reversals },
      draft: { active: drafted.activeWrites, reversals: drafted.reversals },
    };
  }

  /** Where each selected write landed; only a thread with drafted history splits. */
  function routes(
    histories: Histories | null,
    direction: "undo" | "redo",
    selection: ReversalSelection,
  ) {
    if (!histories) return new Map([["live" as const, { selection, handles: [] as string[] }]]);
    return splitReversal({ direction, selection, ...histories });
  }

  function coreAt(side: ReversalSide, threadId: string | undefined) {
    return side === "live" ? Promise.resolve(input.liveUtilityCore) : input.coreFor(threadId);
  }

  /** The core holding the write a plain undo or redo would reverse. */
  function latestCore(
    histories: Histories | null,
    threadId: string,
    direction: "undo" | "redo",
  ): Promise<AgentEditCore> {
    const [side] = routes(histories, direction, { kind: "latest" }).keys();
    return coreAt(side ?? "live", threadId);
  }

  /**
   * A reversal's grant at the destination its writes landed in. The call's
   * grant names where new writes go, which a mode switch since may have moved.
   */
  async function grantAt(
    grant: FileGrant<"edit">,
    side: ReversalSide,
  ): Promise<FileGrant<"edit"> | FileAccessDenied> {
    const caller = grant.principal.agent?.chain[0];
    if (grant.destination.kind === side || !caller) return grant;
    const destination: FileDestination =
      side === "draft"
        ? { kind: "draft", workId: caller.threadWorkId, workSlug: null }
        : { kind: "live" };
    return input.fileAccess.authorizeAt(grant.principal, grant.facts.target, destination);
  }

  return {
    /**
     * History decides where a reversal goes, not the current destination. A
     * journal whose grant is refused keeps its writes; the rest still reverse,
     * and the result names the kept ones.
     */
    async reverse(
      command: ReversalCommand,
      context: WriteContext,
      grant: FileGrant<"edit">,
      documentId: DocumentId | null,
    ): Promise<RoutedWriteOutcome> {
      if (!documentId) {
        return input.reverseIn(input.liveUtilityCore, command, null, context, grant);
      }
      const histories = await loadHistories(documentId, context.threadId);
      const outcomes: WriteOutcome[] = [];
      const refused: { writeIds: string[]; denial: FileAccessDenied }[] = [];
      for (const [side, route] of routes(
        histories,
        command.command,
        commandSelection(command, context),
      )) {
        const sideGrant = await grantAt(grant, side);
        try {
          if (isFileAccessDenied(sideGrant)) throw new FileEditRefusedError([sideGrant]);
          const sideCommand =
            route.selection.kind === "last" ? { ...command, last: route.selection.count } : command;
          const core = await coreAt(side, context.threadId);
          outcomes.push(await input.reverseIn(core, sideCommand, documentId, context, sideGrant));
        } catch (cause) {
          if (!(cause instanceof FileEditRefusedError)) throw cause;
          refused.push(...cause.refused.map((denial) => ({ writeIds: route.handles, denial })));
        }
      }
      return mergeReversals(command.command, outcomes, refused);
    },

    async getAvailability(docId: string, threadId: string) {
      const histories = await loadHistories(docId as DocumentId, threadId);
      const [undoCore, redoCore] = await Promise.all([
        latestCore(histories, threadId, "undo"),
        latestCore(histories, threadId, "redo"),
      ]);
      const undo = await undoCore.getAvailability(docId, threadId);
      const redo = redoCore === undoCore ? undo : await redoCore.getAvailability(docId, threadId);
      return {
        undo: undo.undo,
        redo: redo.redo,
        ...(undo.undoWriteId ? { undoWriteId: undo.undoWriteId } : {}),
        ...(undo.undoTarget ? { undoTarget: undo.undoTarget } : {}),
        ...(redo.redoWriteId ? { redoWriteId: redo.redoWriteId } : {}),
      };
    },

    async undo(docId: string, threadId: string) {
      const histories = await loadHistories(docId as DocumentId, threadId);
      return (await latestCore(histories, threadId, "undo")).undo(docId, threadId);
    },

    async redo(docId: string, threadId: string) {
      const histories = await loadHistories(docId as DocumentId, threadId);
      return (await latestCore(histories, threadId, "redo")).redo(docId, threadId);
    },
  };
}
