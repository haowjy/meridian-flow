/**
 * Test-only file grants. Tests of routing and saving mint a grant for a
 * destination without asking the policy, and confirm every grant; tests of
 * access use the real `createFileAccess`.
 */
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  createAllowAllFileAccess,
  createDrizzleFileFacts,
  createFileAccess,
  createOwnerFileGrants,
  type FileAccess,
  type FileDestination,
  type FileGrant,
} from "../domains/file-policy/index.js";
import { runWithEditConfirmation } from "../shared/edit-confirmation.js";

export function testFileGrant(
  destination: FileDestination = { kind: "live" },
  documentId = "00000000-0000-4000-8000-0000000000f1",
): FileGrant<"edit"> {
  const target = { kind: "document", documentId: documentId as DocumentId } as const;
  return {
    principal: { accountId: "test-user" as UserId },
    target,
    facts: {
      target,
      projectId: "test-project" as ProjectId,
      ownerAccountId: "test-user" as UserId,
      projectDeleted: false,
      ownerWork: null,
      deleted: false,
      scheme: "manuscript",
      path: "",
      self: { kind: "document", id: documentId as DocumentId },
      ancestors: [],
    },
    level: "edit",
    destination,
  } as unknown as FileGrant<"edit">;
}

/** Grants and confirms everything: for tests where access isn't the subject. */
export const confirmEveryGrant: FileAccess = {
  ...createAllowAllFileAccess(),
  async confirmEdit(grants) {
    return { confirmed: [...grants], refused: [] };
  },
};

/** The real policy over Postgres facts, for routes and readers whose access is under test. */
export function drizzleFileAccess(db: Database): FileAccess {
  return createFileAccess({
    facts: createDrizzleFileFacts(db),
    grants: createOwnerFileGrants(),
    readAgentChain: async () => {
      throw new Error("This test's file access has no agent chains");
    },
  });
}

/** Runs writes as an entry point holding already confirmed grants would: for adapter tests. */
export function asGrantedWriter<T>(operation: () => Promise<T>): Promise<T> {
  return runWithEditConfirmation({ workIds: [], async confirm() {} }, operation);
}

const JOURNAL_WRITES = new Set([
  "append",
  "appendBatch",
  "persistUndo",
  "persistRedo",
  "persistRedoBatch",
]);

/** A journal whose agent writes run as a granted entry point's would. */
export function grantedJournal<J extends object>(journal: J): J {
  return new Proxy(journal, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || !JOURNAL_WRITES.has(String(property))) return value;
      return (...args: unknown[]) => asGrantedWriter(() => value.apply(target, args));
    },
  });
}
