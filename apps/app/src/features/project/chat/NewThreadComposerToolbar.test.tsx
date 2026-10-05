// @vitest-environment jsdom
/** Failed Works acquisition stays recoverable inside the prospective Work picker. */
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { ComposerToolbarModel } from "@/components/app/composer-toolbar";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { NewThreadComposerToolbar } from "./NewThreadComposerToolbar";

vi.mock("@/features/agents/ComposerAgentControl", () => ({
  useComposerAgentToolbarControl: () => ({ kind: "status", id: "agent", priority: 0 }),
}));
vi.mock("@/components/app/composer-toolbar", async (original) => ({
  ...(await original<typeof import("@/components/app/composer-toolbar")>()),
  ComposerToolbar: ({ model }: { model: ComposerToolbarModel }) => {
    const control = model.controls.find(({ id }) => id === "work");
    return control?.kind === "panel"
      ? control.panel.render({
          host: "inline",
          locked: false,
          panel: { controlId: "work", session: 1 },
          requestDismiss: () => "closed",
          beginBlocking: () => ({ kind: "refused" }),
          terminalClose: () => {},
        })
      : null;
  },
}));

it("shows Retry instead of loading when acquisition fails before No Work is known", async () => {
  const retry = vi.fn();
  await withReactRoot(
    <NewThreadComposerToolbar
      projectId="project"
      work={null}
      selectedWorkId={null}
      works={[]}
      noWork={null}
      worksStatus="error"
      agent={null}
      disabled={false}
      onAgentChange={() => {}}
      onWorkChange={() => {}}
      onRetryWorks={retry}
      onModePendingChange={() => {}}
    />,
    async () => {
      expect(document.body.textContent).toContain("Couldn't load Work.");
      expect(document.body.textContent).not.toContain("Loading Work…");
      const button = Array.from(document.querySelectorAll("button")).find(
        (node) => node.textContent === "Retry",
      );
      expect(button).toBeDefined();
      await act(async () => button?.click());
      expect(retry).toHaveBeenCalledOnce();
    },
  );
});
