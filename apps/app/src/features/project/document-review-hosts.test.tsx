// @vitest-environment jsdom
/**
 * One review per document across the Editor and the dock: off a document's address the Editor's
 * frame stays mounted with the selected tab while the dock holds the same document.
 */
import "fake-indexeddb/auto";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { setDocumentView } from "@/client/project-shell/document-views";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { type ContextTab, ThreadStoreProvider } from "@/client/stores";
import { AccountFeatureTestProvider } from "@/test-support/account-feature-provider";
import { type DocumentReview, useDocumentReview } from "./DocumentReview";

const accountId = "account";
const projectId = "project";
const owner = "work:arc-one";
const tab = {
  kind: "tracked",
  id: "chapter",
  documentId: "chapter",
  tabInstanceId: "chapter-tab",
  scheme: "manuscript",
  path: "/Chapter One.md",
  name: "Chapter One.md",
  schemaType: "document",
} as unknown as ContextTab;

function Host({ showing, report }: { showing: boolean; report: (review: DocumentReview) => void }) {
  report(useDocumentReview(projectId, tab, showing));
  return null;
}

it("reviews a document only in the host that shows it", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(projectQueryKeys.ownerDrafts(projectId, owner), {
    items: [{ itemKey: "item", documentId: "chapter" }],
  });
  setDocumentView(accountId, projectId, "chapter", { pin: { ownerKey: owner, itemKey: "item" } });
  let editor: DocumentReview | null = null;
  let dock: DocumentReview | null = null;
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThreadStoreProvider now={0}>
          <AccountFeatureTestProvider accountId={accountId}>
            <Host showing={false} report={(review) => (editor = review)} />
            <Host showing report={(review) => (dock = review)} />
          </AccountFeatureTestProvider>
        </ThreadStoreProvider>
      </QueryClientProvider>,
    );
  });
  expect(dock).toMatchObject({
    paint: { showing: "draft", draft: { itemKey: "item" } },
    value: { controller: { inlineReview: { documentId: "chapter", itemKey: "item" } } },
  });
  expect(editor).toMatchObject({
    paint: { showing: "live", draft: null },
    value: { controller: { inlineReview: null } },
  });
  await act(async () => root.unmount());
});
