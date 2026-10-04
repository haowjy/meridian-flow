/**
 * Test-only file grants. Tests of routing and saving mint a grant for a
 * destination without asking the policy, and confirm every grant; tests of
 * access use the real `createFileAccess`.
 */
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import type { FileAccess, FileDestination, FileGrant } from "../domains/file-policy/index.js";

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

/** Confirms every grant: for tests where access isn't the subject. */
export const confirmEveryGrant: Pick<FileAccess, "confirmEdit"> = {
  async confirmEdit(grants) {
    return { confirmed: [...grants], refused: [] };
  },
};
