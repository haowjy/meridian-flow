/**
 * The tab strip's recents control. Closing every tab used to be the only way back
 * to the recently-opened chooser; this pins the always-available door, and the
 * fact that it appears only when the surface can actually navigate there.
 */
import { act, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { TooltipProvider } from "@/components/ui/tooltip";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextTabBar } from "./ContextTabBar";

// Same macro stubs the other component tests use: the catalogs are not loaded here.
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const tab: ContextTab = {
  kind: "tracked",
  documentId: "doc-a",
  scheme: "manuscript",
  path: "/chapter-1.md",
  name: "chapter-1.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

function Strip(props: Partial<React.ComponentProps<typeof ContextTabBar>>) {
  return (
    // The strip's tab tooltips expect the app root's provider; the + control
    // already depends on it.
    <TooltipProvider>
      <ContextTabBar
        tabs={[tab]}
        activeTabId={tab.documentId}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />
    </TooltipProvider>
  );
}

const recentsControl = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Recently opened"]');

it("renders no door when the surface cannot navigate there", async () => {
  await withReactRoot(<Strip />, () => {
    expect(recentsControl()).toBeNull();
  });
});

it("returns to the chooser without closing what is open", async () => {
  const onShowRecents = vi.fn();
  await withReactRoot(<Strip onShowRecents={onShowRecents} />, async () => {
    // An addition, not a replacement: the open tab stays open.
    expect(document.querySelector('[role="tab"][aria-label="chapter-1.md"]')).not.toBeNull();
    await act(async () => recentsControl()?.click());
    expect(onShowRecents).toHaveBeenCalledTimes(1);
  });
});

it("reads as the current place while the chooser is on screen", async () => {
  await withReactRoot(<Strip onShowRecents={vi.fn()} recentsActive />, () => {
    expect(recentsControl()?.getAttribute("aria-current")).toBe("page");
  });
});
