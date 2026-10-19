/** In-memory cores and draft history for thread-peer pool unit tests. */
import type {
  AgentEditCore,
  ResponseCommitSuccessResult,
  WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { vi } from "vitest";
import type { DraftSnapshot } from "../domain/draft-store.js";
import type { Branch } from "../domain/ports/branch-store.js";
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
    // An attempt that persists nothing of its own and installs through `commitResponse`.
    prepareResponse: vi.fn(async (responseId: string, commit?: FakeCommitOptions) => ({
      consume: async () => {},
      install: () => fake.commitResponse(responseId, commit),
      dispose() {},
      fail: async (cause: unknown): Promise<never> => {
        throw cause;
      },
    })),
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
    refuseStaged: vi.fn((..._args: unknown[]) => {}),
    retirePeer: vi.fn(async (..._args: unknown[]) => {}),
    invalidateThreadDocument: vi.fn(async (..._args: unknown[]) => {}),
    evictThread: vi.fn(async (..._args: unknown[]) => {}),
  };
  return Object.assign(fake, { asCore: () => fake as unknown as AgentEditCore });
}

export const FAKE_BRANCH_ID = "branch-1" as BranchId;
export const FAKE_UPSTREAM_ID = "upstream-1";

/** A pull that names a fresh peer each call, as a reply's replacement peer would be. */
function fakePulls() {
  let pulled = 0;
  return vi.fn(
    async (_input: { documentId: DocumentId; threadId: ThreadId; branchId?: BranchId }) => ({
      peerDraftId: `peer-${++pulled}`,
      upstreamDraftId: FAKE_UPSTREAM_ID,
      attributionBaseline: new Uint8Array(),
    }),
  );
}

/** In-process cores with an observed thread-peer pull. */
export function createFakeThreadPeerCores() {
  return {
    liveCore: createFakeAgentEditCore("live"),
    threadCore: createFakeAgentEditCore("thread"),
    pullThreadPeer: fakePulls(),
  };
}

/** The Work branch the pool pins a drafted write to. */
export function createFakeBranches() {
  return {
    viewForWork: vi.fn(async (_workId: unknown) => ({
      kind: "branch" as const,
      branchId: FAKE_BRANCH_ID,
    })),
    ensureActiveForWrite: vi.fn(async (_input: unknown) => ({ id: FAKE_BRANCH_ID }) as Branch),
    shareActive: vi.fn(async (_branchId: BranchId) => ({ id: FAKE_BRANCH_ID }) as Branch | null),
  };
}

type FakeDraft = {
  generation?: number;
  status: "active" | "closed";
  kind: "thread_peer" | "work_draft";
  branchId: BranchId;
  documentId: string;
  threadId: string | null;
  upstreamDraftId: string | null;
};

/**
 * The draft rows a reply's pins name. Every `peer-N` the fake pull hands out is an active
 * peer of `thread` on `document` under the one fake upstream, until a test closes or deletes it.
 */
export function createFakeDraftTable(input: { documentId: string; threadId: string }) {
  const overrides = new Map<string, FakeDraft | null>();
  return {
    set: (draftId: string, documentDraft: FakeDraft | null) =>
      overrides.set(draftId, documentDraft),
    close: (draftId: string) => {
      const row = overrides.get(draftId) ?? defaultRow(draftId);
      if (row) overrides.set(draftId, { ...row, status: "closed" });
    },
    getDraft: vi.fn(
      async (draftId: string) =>
        (overrides.has(draftId)
          ? overrides.get(draftId)
          : defaultRow(draftId)) as DraftSnapshot | null,
    ),
  };
  function defaultRow(draftId: string): FakeDraft | null {
    if (draftId === FAKE_UPSTREAM_ID)
      return {
        status: "active",
        kind: "work_draft",
        branchId: FAKE_BRANCH_ID,
        documentId: input.documentId,
        threadId: null,
        upstreamDraftId: null,
      };
    if (!draftId.startsWith("peer-")) return null;
    return {
      status: "active",
      kind: "thread_peer",
      branchId: FAKE_BRANCH_ID,
      documentId: input.documentId,
      threadId: input.threadId,
      upstreamDraftId: FAKE_UPSTREAM_ID,
    };
  }
}

/** Pool wiring with no database: settles inline and runs the save in-process. */
export const inProcessResponseTransactions = {
  responseTransactionSettlement: {
    deferUntilCommit: () => false,
    deferUntilRollback: () => false,
  },
  responseTransactions: { enlist: enlistResponseParticipant, run: runResponseTransaction },
};

/**
 * A file policy that confirms every grant. It stands apart from `createAllowAllFileAccess` so
 * the pool's unit tests load none of the policy's database adapters.
 */
export function createFakeFileAccess() {
  return {
    authorize: vi.fn(async () => ({ ok: true })),
    authorizeAt: vi.fn(async () => ({ ok: true })),
    confirmEdit: vi.fn(async (_grants: readonly unknown[]) => [] as never[]),
  } as unknown as Pick<
    import("../../file-policy/index.js").FileAccess,
    "authorize" | "authorizeAt" | "confirmEdit"
  >;
}

/** An edit grant for a destination, shaped as the policy mints it. */
export function fakeEditGrant(
  destination: import("../../file-policy/index.js").FileDestination,
  documentId = "ch12",
) {
  return {
    principal: { accountId: "test-user" },
    facts: {
      target: { kind: "document", documentId },
      projectId: "test-project",
      ownerAccountId: "test-user",
      projectDeleted: false,
      ownerWork: null,
      deleted: false,
      scheme: "manuscript",
      self: { kind: "document", id: documentId },
      ancestors: [],
      ...(destination.kind === "draft"
        ? {
            branchWork: {
              id: destination.workId,
              slug: destination.workSlug,
              isNoWork: false,
              archived: false,
              deleted: false,
            },
          }
        : {}),
    },
    destination,
  } as unknown as import("../../file-policy/index.js").FileGrant<"edit">;
}
