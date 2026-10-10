/** In-memory cores and branch history for thread-peer pool unit tests. */
import type {
  AgentEditCore,
  ResponseCommitSuccessResult,
  WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { DraftId, LinkView } from "@meridian/contracts";
import type { DocumentId, ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import { vi } from "vitest";
import * as Y from "yjs";
import { createAllowAllFileAccess } from "../../file-policy/index.js";
import { createBranchCriticalSections } from "../domain/branch-critical-sections.js";
import type { BranchJournalRow } from "../domain/branch-push-contracts.js";
import { BranchNotFoundError } from "../domain/branch-resolver.js";
import type { BranchReversalHistoryReader } from "../domain/branch-reversal-history.js";
import type { Draft } from "../domain/ports/draft-store.js";
import { createReplySaveFences } from "../domain/reply-save-fences.js";
import {
  enlistResponseParticipant,
  runResponseTransaction,
} from "../domain/response-transaction.js";

const success = {
  status: "success",
  phase: "committed",
  isError: false,
  result: { command: "read", status: "success", read: { format: "full" } },
} as unknown as WriteOutcome;

type WrittenCommand = { command: string; file?: string; documentId?: string };
type FakeCommitOptions = {
  deferFinalization?(participant: { commit(): void; abort(): void }): void;
};

/**
 * A core whose methods are spies. `name` tags its staged document and the value
 * `withResponseDocument` resolves to, so a test can tell which core answered.
 */
function createFakeAgentEditCore(
  name: string,
  options: { onWrite?(command: WrittenCommand, context: { threadId?: string }): void } = {},
) {
  const committed = (responseId: string): ResponseCommitSuccessResult => ({
    status: "committed",
    responseId,
    documentCount: 1,
    updateCount: 1,
    documents: [{ documentId: `${name}-doc`, updateCount: 1, receipts: [] }],
    stagedCreates: { committed: [], discarded: [] },
  });
  const fake = {
    read: vi.fn(async (..._args: unknown[]) => success),
    write: vi.fn(async (command: WrittenCommand, context: { threadId?: string }) => {
      options.onWrite?.(command, context);
      return success;
    }),
    commitResponse: vi.fn(async (responseId: string, commit?: FakeCommitOptions) => {
      commit?.deferFinalization?.({ commit() {}, abort() {} });
      return committed(responseId);
    }),
    rollbackResponse: vi.fn(async (responseId: string, _options?: unknown) => ({
      status: "rolledBack" as const,
      responseId,
      stagedCreates: { committed: [], discarded: [] },
    })),
    hasResponseDocument: vi.fn((_responseId: string, _documentId: string) => false),
    withResponseDocument: vi.fn(async (..._args: unknown[]): Promise<unknown> => name),
    responseDocuments: vi.fn((_responseId: string) => ({
      staged: [`${name}-doc`],
      created: [] as string[],
    })),
    invalidateThreadDocument: vi.fn(async (..._args: unknown[]) => {}),
    evictThread: vi.fn(async (..._args: unknown[]) => {}),
  };
  return Object.assign(fake, { asCore: () => fake as unknown as AgentEditCore });
}

/** The Work whose draft the fake history's thread peers sit under. */
export const FAKE_DRAFT_WORK_ID = "00000000-0000-4000-8000-00000000f00d" as WorkId;

/**
 * Branch history as the real `resolveBranchReversalScope` reads it. A thread has
 * no peer until `pullThreadPeer` creates one under a Work draft, and owns undo
 * history there only once `recordDraftedWrite` lands an agent row.
 */
function createFakeReversalHistory() {
  const peers = new Map<string, string>();
  const branches = new Map<
    string,
    {
      upstreamBranchId: string | null;
      draftId: DraftId;
      workId: WorkId | null;
      generation: number;
    }
  >();
  const rows: BranchJournalRow[] = [];
  const key = (documentId: string, threadId: string) => `${documentId}:${threadId}`;

  const reader: BranchReversalHistoryReader = {
    branches: {
      async resolveThreadBranch(documentId, threadId) {
        const branchId = peers.get(key(documentId, threadId));
        if (!branchId) throw new BranchNotFoundError(documentId, threadId);
        return { branchId, doc: new Y.Doc() };
      },
      async getBranch(branchId) {
        const branch = branches.get(branchId);
        return branch ? { ...branch, state: new Uint8Array() } : null;
      },
    },
    branchRows: {
      async listJournalRowsForBranch({ branchId, generation }) {
        return rows.filter((row) => row.branchId === branchId && row.generation === generation);
      },
    },
  };

  return {
    reader,
    /** The live journal holds no writes here: live undo history is the live core's. */
    liveHistory: {
      activeWriteSummary: async () => [],
      readReversals: async () => [],
    },
    pullThreadPeer: vi.fn(
      async (input: { documentId: DocumentId; threadId: ThreadId; draftId: DraftId }) => {
        const peerKey = key(input.documentId, input.threadId);
        if (!peers.has(peerKey)) {
          const draftBranchId = `draft-branch:${input.documentId}`;
          branches.set(draftBranchId, {
            upstreamBranchId: null,
            draftId: input.draftId,
            workId: FAKE_DRAFT_WORK_ID,
            generation: 1,
          });
          branches.set(`peer:${peerKey}`, {
            upstreamBranchId: draftBranchId,
            draftId: input.draftId,
            workId: FAKE_DRAFT_WORK_ID,
            generation: 1,
          });
          peers.set(peerKey, `peer:${peerKey}`);
        }
        return {
          branchId: `peer:${peerKey}`,
          branchGeneration: 1,
          attributionBaseline: new Uint8Array(),
        };
      },
    ),
    /** What a thread core's drafted write leaves in the Work draft's journal. */
    recordDraftedWrite(documentId: string, threadId: string) {
      const peerId = peers.get(key(documentId, threadId));
      const draftBranchId = peerId ? branches.get(peerId)?.upstreamBranchId : null;
      if (!draftBranchId) return;
      rows.push({
        id: rows.length + 1,
        branchId: draftBranchId,
        generation: 1,
        wId: rows.length + 1,
        source: "agent",
        threadId: threadId as ThreadId,
        turnId: null,
        actorUserId: null,
        updateData: new Uint8Array(),
        draftBaseUpdateSeq: 0,
        status: "active",
      });
    },
  };
}

/**
 * A live core and a thread core over shared branch history. The thread core
 * records drafted writes, so undo routing follows what the thread really did.
 */
export function createFakeThreadPeerCores() {
  const history = createFakeReversalHistory();
  const liveCore = createFakeAgentEditCore("live");
  const threadCore = createFakeAgentEditCore("thread", {
    onWrite(command, context) {
      if (command.command === "undo" || command.command === "redo" || !context.threadId) return;
      history.recordDraftedWrite(command.documentId ?? command.file ?? "", context.threadId);
    },
  });
  return { history, liveCore, threadCore };
}

/**
 * Drafts with no database: a Work has no draft until a write ensures one (F7). The save's
 * fences are the real ones over no branches and no locks.
 */
export function createFakeDrafts(liveUtilityCore: AgentEditCore) {
  const active = new Map<WorkId, DraftId>();
  return {
    drafts: {
      viewForWork: async (workId: WorkId | null): Promise<LinkView> => {
        const draftId = workId ? active.get(workId) : undefined;
        return draftId ? { kind: "draft", draftId } : { kind: "live" };
      },
      ensureActiveForWrite: vi.fn(async (input: { workId: WorkId }): Promise<Draft> => {
        const id = active.get(input.workId) ?? (`draft-of-${input.workId}` as DraftId);
        active.set(input.workId, id);
        return {
          id,
          projectId: "project-1" as ProjectId,
          status: "active",
          originWorkId: input.workId,
          originThreadId: null,
          createdBy: "user-1" as UserId,
          createdAt: new Date(0),
        };
      }),
    },
    fences: createReplySaveFences({
      liveUtilityCore,
      branches: { getBranch: async () => null },
      criticalSections: createBranchCriticalSections(),
      drafts: { shareActive: async () => null },
      fileAccess: createAllowAllFileAccess(),
      lockWorks: async () => {},
      lockLiveDocuments: async () => {},
    }),
  };
}

/** Pool wiring with no database: settles inline and runs the save in-process. */
export const inProcessResponseTransactions = {
  responseTransactionSettlement: {
    deferUntilCommit: () => false,
    deferUntilRollback: () => false,
  },
  responseTransactions: { enlist: enlistResponseParticipant, run: runResponseTransaction },
};
