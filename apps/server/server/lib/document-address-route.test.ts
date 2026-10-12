/** Review address selection cannot turn stale or foreign branches into read capabilities. */

import { describe, expect, it, vi } from "vitest";
import type { DraftReviewItem } from "../domains/collab/domain/draft-review-items.js";
import type { DocumentAddressInput } from "../domains/context/ports/document-address.js";
import {
  createFileAccess,
  createOwnerFileGrants,
  type FileFacts,
} from "../domains/file-policy/index.js";
import { handleDocumentAddressRequest } from "./document-address-route.js";

function fixture() {
  const input: Omit<DocumentAddressInput, "view"> = {
    projectId: "project" as never,
    userId: "account",
    scheme: "manuscript",
    workId: null,
    path: "chapters/one.md",
  };
  const item = {
    draftId: "whole-draft",
    draftBranchId: "branch",
    documentId: "document",
    path: "manuscript://chapters/one",
  } as DraftReviewItem;
  const resolved = { kind: "current", document: { documentId: "document" } } as const;
  const deps = {
    workRepo: {
      findById: vi.fn().mockResolvedValue({ id: "work", slug: "review", projectId: "project" }),
    },
    draftReview: { items: vi.fn().mockResolvedValue({ draftId: "whole-draft", items: [item] }) },
    documentAddresses: { resolve: vi.fn().mockResolvedValue(resolved) },
    fileAccess: {
      authorize: vi.fn().mockResolvedValue({ kind: "granted" }),
      authorizeAt: vi.fn().mockResolvedValue({ kind: "granted" }),
    },
  };
  return { input, item, resolved, deps, review: { workId: "work", draftBranchId: "branch" } };
}

it("maps the branch to the active whole draft and authorizes the same draft destination", async () => {
  const { input, deps, review, resolved } = fixture();
  expect(await handleDocumentAddressRequest(deps, input, review)).toEqual(resolved);
  expect(deps.documentAddresses.resolve).toHaveBeenCalledWith({
    ...input,
    view: { kind: "draft", draftId: "whole-draft" },
  });
  expect(deps.fileAccess.authorizeAt).toHaveBeenCalledWith(
    { accountId: "account" },
    { kind: "document", documentId: "document" },
    { kind: "draft", workId: "work", workSlug: "review" },
    "read",
  );
  expect(deps.fileAccess.authorize).not.toHaveBeenCalled();
});

it("leaves plain addresses live-only", async () => {
  const { input, deps } = fixture();
  await handleDocumentAddressRequest(deps, input);
  expect(deps.documentAddresses.resolve).toHaveBeenCalledWith({ ...input, view: undefined });
  expect(deps.draftReview.items).not.toHaveBeenCalled();
  expect(deps.fileAccess.authorizeAt).not.toHaveBeenCalled();
});

describe("unavailable review addresses", () => {
  it.each([
    "another Work",
    "stale branch",
    "path mismatch",
    "another draft",
    "document mismatch",
    "empty document identity",
    "foreign project",
    "deleted Work",
  ])("%s", async (reason) => {
    const { input, deps, review, item } = fixture();
    if (reason === "another Work") {
      review.workId = "rival";
      deps.draftReview.items.mockResolvedValue({ draftId: "rival-draft", items: [] });
    }
    if (reason === "stale branch") review.draftBranchId = "stale";
    if (reason === "path mismatch") input.path = "chapters/two";
    if (reason === "another draft") item.draftId = "old-draft" as never;
    if (reason === "document mismatch") Object.assign(review, { documentId: "other" });
    if (reason === "empty document identity") Object.assign(review, { documentId: "" });
    if (reason === "foreign project")
      deps.workRepo.findById.mockResolvedValue({ projectId: "foreign" });
    if (reason === "deleted Work")
      deps.workRepo.findById.mockResolvedValue({ projectId: "project", deletedAt: new Date() });
    expect(await handleDocumentAddressRequest(deps, input, review)).toEqual({
      kind: "unavailable",
    });
    expect(deps.documentAddresses.resolve).not.toHaveBeenCalled();
    expect(deps.fileAccess.authorizeAt).not.toHaveBeenCalled();
  });

  it("refuses an identity replaced between validation and resolution", async () => {
    const { input, deps, review } = fixture();
    deps.documentAddresses.resolve.mockResolvedValue({
      kind: "current",
      document: { documentId: "replacement" },
    });
    expect(await handleDocumentAddressRequest(deps, input, review)).toEqual({
      kind: "unavailable",
    });
  });
});

it("refuses a validated review when the draft read grant is denied", async () => {
  const { input, deps, review } = fixture();
  deps.fileAccess.authorizeAt.mockResolvedValue({ denied: true });
  expect(await handleDocumentAddressRequest(deps, input, review)).toEqual({ kind: "unavailable" });
});

it("admits an archived Work's review for its owner, but not another account, through the real file policy", async () => {
  const { input, deps, review, resolved } = fixture();
  deps.workRepo.findById.mockResolvedValue({
    id: "work",
    slug: "review",
    projectId: "project",
    archivedAt: new Date(),
  });
  const facts: FileFacts = {
    target: { kind: "document", documentId: "document" },
    projectId: "project" as never,
    ownerAccountId: "account" as never,
    projectDeleted: false,
    ownerWork: null,
    deleted: false,
    scheme: "manuscript",
    self: { kind: "document", id: "document" },
    ancestors: [{ kind: "project", id: "project" as never }],
    draftWork: {
      id: "work" as never,
      slug: "review",
      isNoWork: false,
      archived: true,
      deleted: false,
    },
  };
  const access = createFileAccess({
    facts: {
      load: async ({ draftWorkId }) => (draftWorkId === facts.draftWork?.id ? facts : null),
      loadList: async () => new Map(),
    },
    grants: createOwnerFileGrants(),
    readAgentChain: async () => [],
  });
  const services = { ...deps, fileAccess: access };
  expect(await handleDocumentAddressRequest(services, input, review)).toEqual(resolved);
  expect(
    await handleDocumentAddressRequest(services, { ...input, userId: "another-account" }, review),
  ).toEqual({ kind: "unavailable" });
  // The owner's admitted read must not also grant mutation on this frozen draft.
  expect(
    await access.authorizeAt(
      { accountId: input.userId as never },
      facts.target,
      { kind: "draft", workId: "work" as never, workSlug: "review" },
      "edit",
    ),
  ).toMatchObject({ denied: true, reason: "work_archived" });
});
