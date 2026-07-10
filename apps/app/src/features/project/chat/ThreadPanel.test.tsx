/** Thread row attention badge semantics and token styling. */
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { withReactRoot } from "@/test-support/react-dom-harness";

const renderMessage = (parts: TemplateStringsArray | string): string =>
  typeof parts === "string" ? parts : parts.join("");
vi.mock("@lingui/core/macro", () => ({
  t: renderMessage,
  msg: renderMessage,
}));

const { ThreadAttentionBadge } = await import("./ThreadPanel");

describe("ThreadAttentionBadge", () => {
  it.each([
    ["actionRequired", "interrupt", "The AI asked you a question", "bg-status-warning"],
    ["unread", "waiting", "New reply since you last opened", "bg-jade-text"],
  ] as const)("renders the %s badge with its concrete hover label", async (attention, lifecycle, label, token) => {
    await withReactRoot(
      <TooltipProvider>
        <ThreadAttentionBadge attention={attention} lifecycle={lifecycle} />
      </TooltipProvider>,
      () => {
        const badge = document.querySelector(`[aria-label="${label}"]`);
        expect(badge).not.toBeNull();
        expect(badge?.innerHTML).toContain(token);
      },
    );
  });

  it("renders no attention tooltip for none", async () => {
    await withReactRoot(
      <TooltipProvider>
        <ThreadAttentionBadge attention="none" lifecycle="idle" />
      </TooltipProvider>,
      () => expect(document.querySelector("[aria-label]")).toBeNull(),
    );
  });
});
