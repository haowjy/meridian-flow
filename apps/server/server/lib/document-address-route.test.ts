/** Review identity admission preserves draft authority without trusting a client selector. */

import type { DocumentAddressResult } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import type { DraftReviewItem } from "../domains/collab/domain/draft-review-items.js";
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
    work: { id: "work", slug: "review", projectId: "project", deletedAt: null as Date | null },
    draftId: "whole-draft" as string | null,
    items: [
      {
        draftId: "whole-draft",
        itemKey: "whole-draft:hidden",
        draftBranchId: "branch",
        documentId: "hidden",
        path: "kb://Withern",
      },
    ] as DraftReviewItem[],
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
      state.available && selected.documentId === "hidden" && selected.view?.kind === "draft"
        ? document("hidden")
        : { kind: "unavailable" },
  };
  const deps = {
    workRepo: {
      findById: async (id: string) => (id === state.work.id ? (state.work as never) : null),
    },
    draftReview: { items: async () => ({ draftId: state.draftId, items: state.items }) as never },
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
    review: { workId: "work", itemKey: "whole-draft:hidden" },
  };
}

it("selects the branch's hidden document rather than the live path occupant", async () => {
  const { input, deps, review } = fixture();
  expect(await handleDocumentAddressRequest(deps, input, review)).toMatchObject({
    kind: "current",
    document: { documentId: "hidden" },
  });
  expect(await handleDocumentAddressRequest(deps, input)).toMatchObject({
    kind: "current",
    document: { documentId: "live" },
  });
});

it("repairs an old locator from branch identity, a copied selector never names the document", async () => {
  const { input, deps, review } = fixture();
  input.path = "Before rename";
  expect(
    await handleDocumentAddressRequest(deps, input, {
      workId: review.workId,
      itemKey: review.itemKey,
    }),
  ).toMatchObject({
    kind: "current",
    document: { documentId: "hidden", entry: { uri: "kb://Renamed" } },
  });
});

it.each([
  "bad item key",
  "a branch id in the item key",
  "another Work",
  "foreign project",
  "deleted Work",
  "inactive draft",
  "another draft",
  "empty key",
  "denied grant",
  "missing identity",
  "ambiguous item",
])("answers unavailable for %s", async (reason) => {
  const { input, state, deps, review } = fixture();
  if (reason === "bad item key") review.itemKey = "bad";
  if (reason === "a branch id in the item key") review.itemKey = "branch";
  if (reason === "another Work") review.workId = "other";
  if (reason === "foreign project") state.work.projectId = "other";
  if (reason === "deleted Work") state.work.deletedAt = new Date();
  if (reason === "inactive draft") state.draftId = null;
  if (reason === "another draft")
    state.items = state.items.map((item) => ({ ...item, draftId: "old" as never }));
  if (reason === "empty key") review.itemKey = "";
  if (reason === "denied grant") state.denied = true;
  if (reason === "missing identity") state.available = false;
  if (reason === "ambiguous item") state.items = [...state.items, ...state.items];
  expect(await handleDocumentAddressRequest(deps, input, review)).toEqual({ kind: "unavailable" });
});
