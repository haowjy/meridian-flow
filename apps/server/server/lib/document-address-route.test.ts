/** Review identity admission preserves draft authority without trusting a client selector. */

import type { DocumentAddressResult } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import type { DraftReviewApi } from "../domains/collab/contracts.js";
import type { DraftReviewItem } from "../domains/collab/domain/branch-review-items.js";
import type { DocumentAddressResolver } from "../domains/context/ports/document-address.js";
import type { FileDestination } from "../domains/file-policy/index.js";
import { handleDocumentAddressRequest } from "./document-address-route.js";

function fixture() {
  const input = {
    projectId: "project" as never,
    userId: "account",
    scheme: "kb" as const,
    workId: null,
    path: "Withern",
  };
  const state = {
    work: {
      id: "work",
      handle: "w1",
      isNoWork: false,
      projectId: "project",
      deletedAt: null as Date | null,
    },
    // The resolver's explicit answer for the review's item, or null when the draft is inactive.
    resolved: {
      branchId: "whole-branch",
      itemKey: "whole-branch:hidden",
      documentId: "hidden",
      draftId: "draft",
      item: {} as DraftReviewItem,
      listed: true,
    } as unknown as Awaited<ReturnType<DraftReviewApi["resolveItem"]>>,
    denied: false,
    available: true,
  };
  const document = (documentId: string): DocumentAddressResult =>
    ({
      kind: "current",
      document: { documentId, entry: { uri: "kb://Renamed" } },
    }) as DocumentAddressResult;
  const documentAddresses: DocumentAddressResolver = {
    resolve: async () => document("live"),
    resolveById: async (selected) =>
      state.available && selected.documentId === "hidden" && selected.view?.kind === "branch"
        ? document("hidden")
        : { kind: "unavailable" },
  };
  const deps = {
    workRepo: {
      findById: async (id: string) => (id === state.work.id ? (state.work as never) : null),
    },
    draftReview: { resolveItem: async () => state.resolved },
    documentAddresses,
    fileAccess: {
      authorize: async () =>
        state.denied ? ({ denied: true } as never) : ({ kind: "granted" } as never),
      authorizeAt: async (_actor: unknown, _target: unknown, destination: FileDestination) =>
        destination.kind === "draft" && destination.workId === state.work.id && !state.denied
          ? ({ kind: "granted" } as never)
          : ({ denied: true } as never),
    },
  };
  return {
    input,
    state,
    deps,
    review: { workId: "work", itemKey: "whole-branch:hidden" },
  };
}

it.each([
  "another Work",
  "foreign project",
  "deleted Work",
  "inactive branch",
  "denied grant",
  "missing identity",
])("answers unavailable for %s", async (reason) => {
  const { input, state, deps, review } = fixture();
  if (reason === "another Work") review.workId = "other";
  if (reason === "foreign project") state.work.projectId = "other";
  if (reason === "deleted Work") state.work.deletedAt = new Date();
  if (reason === "inactive branch") state.resolved = null;
  if (reason === "denied grant") state.denied = true;
  if (reason === "missing identity") state.available = false;
  expect(await handleDocumentAddressRequest(deps, input, review)).toEqual({ kind: "unavailable" });
});
