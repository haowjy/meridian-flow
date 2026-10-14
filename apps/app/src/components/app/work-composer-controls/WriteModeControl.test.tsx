// @vitest-environment jsdom
/** The write-mode control's Draft count follows the Work's draft list, one per document. */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { listed } from "@/test-support/draft-review-scope";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import { useWriteModeToolbarControl } from "./WriteModeControl";

vi.mock("@/client/api/drafts-api", () => ({ listWorkDrafts: vi.fn(() => new Promise(() => {})) }));

const draftOf = (documentId: string): ThreadDraftListItem => ({
  ...listed,
  itemKey: `draft-${documentId}`,
  documentId,
});

describe("write-mode control draft count", () => {
  it("counts the documents waiting in the chosen Work's draft", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(projectQueryKeys.workDrafts("p", "work-a"), [
      draftOf("doc-1"),
      draftOf("doc-2"),
    ]);
    queryClient.setQueryData(projectQueryKeys.workDrafts("p", "work-b"), []);
    const seen: Record<string, string> = {};
    function Probe({ workId }: { workId: string }) {
      const control = useWriteModeToolbarControl({
        projectId: "p",
        workId,
        value: "draft",
        onChoose: () => {},
      });
      seen[workId] = String(control.item.value);
      return null;
    }
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <Probe workId="work-a" />
        <Probe workId="work-b" />
      </QueryClientProvider>,
      () =>
        settleReact(() => {
          expect(seen["work-a"]).toBe("Draft (2)");
          expect(seen["work-b"]).toBe("Draft");
        }),
    );
  });
});
