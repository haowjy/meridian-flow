import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";
import { WorkspaceNavBody } from "./WorkspaceNavBody";

vi.mock("@/features/account/AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("./screens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./screens")>()),
  screenLabel: (screen: string) => screen,
}));

describe("WorkspaceNavBody", () => {
  it("starts desktop navigation without a top spacer while preserving phone spacing", async () => {
    await withReactRoot(
      <WorkspaceNavBody
        activeScreen="home"
        onSelectScreen={() => undefined}
        presentation="desktop"
      />,
      async () => {
        const nav = destinationNav();
        const active = nav.querySelector('[aria-current="page"]');

        expect(nav.className).toContain("gap-0.5 border-b border-border-subtle pb-2");
        expect(nav.className.split(" ")).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^-?(?:pt|mt|translate-y)-/)]),
        );
        expect(active?.className).toContain("bg-sidebar-accent");
        expect(active?.getAttribute("aria-current")).toBe("page");
      },
    );

    await withReactRoot(
      <WorkspaceNavBody
        activeScreen="home"
        onSelectScreen={() => undefined}
        presentation="phone"
      />,
      async () => {
        expect(destinationNav().className).toContain("gap-1 px-3 py-3");
        expect(destinationNav().querySelector("button")?.className).toContain("min-h-11");
      },
    );
  });
});

function destinationNav(): HTMLDivElement {
  const nav = document.querySelector("div.flex.shrink-0.flex-col");
  if (!(nav instanceof window.HTMLDivElement)) throw new Error("Missing destination navigation");
  return nav;
}
