import type { DraftOwner } from "@meridian/contracts";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  createDrizzleFileFacts,
  createFileAccess,
  createOwnerFileGrants,
  type FileAccess,
  type FileDestination,
  type FileGrant,
} from "../domains/file-policy/index.js";
import { runWithEditConfirmation } from "../shared/edit-confirmation.js";

export type TestDestination =
  | { kind: "live" }
  | (Extract<FileDestination, { kind: "draft" }> & { owner: DraftOwner });

export function testFileGrant(
  given: TestDestination = { kind: "live" },
  documentId = "00000000-0000-4000-8000-0000000000f1",
): FileGrant<"edit"> {
  const destination: FileDestination =
    given.kind === "draft"
      ? { kind: "draft", draftId: given.draftId, ownerHandle: given.ownerHandle }
      : given;
  const target = { kind: "document", documentId: documentId as DocumentId } as const;
  return {
    principal: {
      accountId: "test-user" as UserId,
      ...(given.kind === "draft"
        ? {
            agent: {
              projectId: "test-project" as ProjectId,
              chain: [],
              draftOwner: {
                owner: given.owner,
                draftId: given.draftId,
                handle: given.ownerHandle,
              },
              writeMode: "draft" as const,
            },
          }
        : {}),
    },
    facts: {
      target,
      owner: { kind: "project", projectId: "test-project" },
      ownerAccountId: "test-user" as UserId,
      projectDeleted: false,
      ownerWork: null,
      deleted: false,
      scheme: "manuscript",
      self: { kind: "document", id: documentId as DocumentId },
      ancestors: [],
      ...(given.kind === "draft"
        ? {
            draftOwner: {
              draftId: given.draftId,
              owner: given.owner,
              handle: given.ownerHandle,
              isNoWork: false,
              archived: false,
              deleted: false,
              purged: false,
              frozen: false,
            },
          }
        : {}),
    },
    destination,
    need: "edit",
  } as unknown as FileGrant<"edit">;
}

export function drizzleFileAccess(db: Database): FileAccess {
  return createFileAccess({
    facts: createDrizzleFileFacts(db),
    grants: createOwnerFileGrants(),
    readAgentChain: async () => {
      throw new Error("This test's file access has no agent chains");
    },
  });
}

export function asGrantedWriter<T>(operation: () => Promise<T>): Promise<T> {
  return runWithEditConfirmation(
    { workIds: [], lineageRootIds: [], async confirm() {}, covers: async () => true },
    operation,
  );
}

export function grantInProject<G extends FileGrant>(
  grant: G,
  projectId: string,
  accountId?: string,
): G {
  return {
    ...grant,
    principal: {
      ...grant.principal,
      ...(accountId ? { accountId: accountId as UserId } : {}),
      ...(grant.principal.agent
        ? { agent: { ...grant.principal.agent, projectId: projectId as ProjectId } }
        : {}),
    },
    facts: {
      ...grant.facts,
      owner: { kind: "project", projectId },
      ...(accountId ? { ownerAccountId: accountId as UserId } : {}),
    },
  };
}
