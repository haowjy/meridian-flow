// @vitest-environment jsdom
/** Real shared review state and scope effect ordering on a same-document Work switch. */
import "fake-indexeddb/auto";
import { emptyCatalogView } from "@meridian/resource-replica";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { expect, it } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { DraftReviewContextValue } from "@/features/chat/DraftReviewProvider";
import { useDraftReviewScopeValue } from "@/features/chat/DraftReviewProvider";
import { useDraftReviewStateOwner } from "@/features/chat/useDraftReviewController";
import { EditorReviewAddressOwner } from "@/features/project/dock/EditorReviewAddressOwner";
import { EditorReviewHandoffProvider } from "@/features/project/dock/editor-review-handoff";
import { AccountFeatureTestProvider } from "@/test-support/account-feature-provider";
import { withReactRoot } from "@/test-support/react-dom-harness";

it("a same-document Work switch preserves the newly requested branch and the old owner provenance", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const work of ["a", "b"])
    client.setQueryData(projectQueryKeys.workDrafts("project", work), [
      {
        workId: work,
        itemKey: `branch-${work}`,
        documentId: "document",
        status: "active",
        updatedAt: "2026-10-12T00:00:00Z",
        contextLocation: { scheme: "kb", path: "/Same" },
        documentName: "Same",
      },
    ]);
  const scope = { kind: "project" as const, projectId: "project" };
  client.setQueryData(projectQueryKeys.contextCatalog("project", scope), emptyCatalogView(scope));
  let enter!: () => void;
  let switchWork!: () => void;
  const rewrites: string[] = [];
  function Harness() {
    const stateOwner = useDraftReviewStateOwner();
    const [workId, setWorkId] = useState("a");
    const [branch, setBranch] = useState<string | null>(null);
    enter = () =>
      stateOwner.dispatch({ type: "enterInline", documentId: "document", itemKey: "branch-a" });
    switchWork = () => {
      setWorkId("b");
      setBranch("branch-b");
    };
    const review = useDraftReviewScopeValue({
      projectId: "project",
      work: { id: workId, projectId: "project", name: workId, archivedAt: null } as never,
      stateOwner,
    });
    return (
      <EditorReviewHandoffProvider
        projectId="project"
        openContextRoute={async () => ({ kind: "applied" })}
      >
        <EditorReviewAddressOwner
          reviewAddressAdmission="admitted"
          review={review}
          requestedItemKey={branch ?? undefined}
          activeScreen="context"
          activeScheme="kb"
          activePath="/Same"
          activeDocumentId="document"
          onSetItemKey={(next) => {
            rewrites.push(`${workId}:${next ?? "plain"}`);
            setBranch(next);
          }}
        />
        <output>
          {workId}:{branch ?? "plain"}:{review.controller.inlineReview?.itemKey ?? "no-review"}
        </output>
      </EditorReviewHandoffProvider>
    );
  }
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <AccountFeatureTestProvider accountId="binding-probe">
          <Harness />
        </AccountFeatureTestProvider>
      </QueryClientProvider>,
      async () => {
        await act(async () => enter());
        expect(document.querySelector("output")?.textContent).toBe("a:branch-a:branch-a");
        rewrites.length = 0;
        await act(async () => switchWork());
        expect(rewrites).not.toContain("b:branch-a");
        expect(document.querySelector("output")?.textContent).toBe("b:branch-b:no-review");
      },
      { drainMacrotask: true },
    );
  } finally {
    client.clear();
  }
});
it("an explicit branch switch wins over the old unresolved same-locator review", async () => {
  let switchBranch!: () => void;
  function Harness() {
    const [branch, setBranch] = useState<string | null>("a");
    switchBranch = () => setBranch("b");
    const groups = ["a", "b"].map((id) => ({
      documentId: `doc-${id}`,
      contextLocation: { scheme: "kb", path: "/Collision" },
      draft: { itemKey: id },
    }));
    const review = {
      controller: {
        workId: "work",
        inlineReview: { documentId: "doc-a", itemKey: "a" },
        exitInlineReview: () => undefined,
      },
      drafts: { status: "ready" },
      groups,
      groupForDocument: (id: string) => groups.find((group) => group.documentId === id),
    } as unknown as DraftReviewContextValue;
    return (
      <EditorReviewHandoffProvider
        projectId="project"
        openContextRoute={async () => ({ kind: "applied" })}
      >
        <EditorReviewAddressOwner
          reviewAddressAdmission="pending"
          review={review}
          requestedItemKey={branch ?? undefined}
          activeScreen="context"
          activeScheme="kb"
          activePath="/Collision"
          onSetItemKey={setBranch}
        />
        <output>{branch}</output>
      </EditorReviewHandoffProvider>
    );
  }
  await withReactRoot(<Harness />, async () => {
    await act(async () => switchBranch());
    expect(document.querySelector("output")?.textContent).toBe("b");
  });
});
