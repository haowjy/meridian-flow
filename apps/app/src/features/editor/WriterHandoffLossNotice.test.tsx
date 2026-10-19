/** Handoff loss belongs to its document and survives leaving review until dismissed. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { expect, it } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { TooltipProvider } from "@/components/ui/tooltip";
import { reviewRoomRef } from "@/features/draft-review/review-room-ref";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import { WriterHandoffLossNotice } from "./WriterHandoffLossNotice";

it("keeps one loss sentence on the addressed document until dismissal", async () => {
  const client = new QueryClient();
  const reference = reviewRoomRef(
    client,
    {
      projectId: "project",
      workId: "work",
      documentId: "affected",
      itemKey: "draft",
    },
    "draft:review",
  );
  reference.writerLoss?.();
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <section data-doc="other">
            <WriterHandoffLossNotice projectId="project" documentId="other" />
          </section>
          <section data-doc="affected">
            <WriterHandoffLossNotice projectId="project" documentId="affected" />
          </section>
        </TooltipProvider>
      </QueryClientProvider>,
      async () => {
        expect(document.querySelector('[data-doc="other"] [role="alert"]')).toBeNull();
        expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Some typing inside a discarded change couldn't be kept.",
        );
        await act(async () => {
          document
            .querySelector<HTMLButtonElement>('[aria-label="Dismiss typing notice"]')
            ?.click();
        });
        await settleReact(() => expect(document.querySelector('[role="alert"]')).toBeNull());
        expect(client.getQueryData(projectQueryKeys.writerHandoffLoss("project", "affected"))).toBe(
          false,
        );
      },
      { drainMacrotask: true },
    );
  } finally {
    client.clear();
  }
});
