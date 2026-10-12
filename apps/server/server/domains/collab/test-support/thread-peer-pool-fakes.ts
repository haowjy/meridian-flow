/** In-memory cores and branch history for thread-peer pool unit tests. */
import type {
  AgentEditCore,
  ResponseCommitSuccessResult,
  WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { vi } from "vitest";
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
 * metadata identifies, so a test can tell which core answered.
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
    prepare: vi.fn(async () => null),
    responseDocuments: vi.fn((_responseId: string) => ({
      staged: [`${name}-doc`],
      created: [] as string[],
    })),
    invalidateThreadDocument: vi.fn(async (..._args: unknown[]) => {}),
    evictThread: vi.fn(async (..._args: unknown[]) => {}),
  };
  return Object.assign(fake, { asCore: () => fake as unknown as AgentEditCore });
}

/** In-process cores with an observed thread-peer pull. */
export function createFakeThreadPeerCores() {
  return {
    liveCore: createFakeAgentEditCore("live"),
    threadCore: createFakeAgentEditCore("thread"),
    pullThreadPeer: vi.fn(async (_input: { documentId: DocumentId; threadId: ThreadId }) => ({
      branchGeneration: 1,
      attributionBaseline: new Uint8Array(),
    })),
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
