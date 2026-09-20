// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ChatThreadNavigationProvider } from "./ChatThreadNavigation";
import { SpawnReportCard } from "./SpawnReportCard";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function findButton(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name,
  ) as HTMLButtonElement | undefined;
}

describe("SpawnReportCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("opens the child chat from the report's door", async () => {
    const openThread = vi.fn();
    await act(async () =>
      root.render(
        <ChatThreadNavigationProvider onOpenThread={openThread}>
          <SpawnReportCard
            agentName="Critic"
            title={null}
            summary="Everything holds."
            status="completed"
            childThreadId="child-1"
          />
        </ChatThreadNavigationProvider>,
      ),
    );

    await act(async () => findButton("Open")?.click());
    expect(openThread).toHaveBeenCalledWith("child-1");
  });

  it("degrades Open to inert text outside a provider", async () => {
    await act(async () =>
      root.render(
        <SpawnReportCard
          agentName="Helper"
          title={null}
          summary="2+2=4."
          status="completed"
          childThreadId="child-2"
        />,
      ),
    );

    expect(document.querySelector("button")).toBeNull();
    expect(document.body.textContent).toContain("Open");
  });

  it("renders returned artifacts alongside the summary", async () => {
    await act(async () =>
      root.render(
        <SpawnReportCard
          agentName="Critic"
          title={null}
          summary="Wrote the outline."
          status="completed"
          childThreadId={null}
          artifacts={[{ type: "object", uri: "scratch://outline.md", label: "Outline" }]}
        />,
      ),
    );

    const link = document.querySelector("a[href='scratch://outline.md']");
    expect(link).not.toBeNull();
    expect(document.body.textContent).toContain("Outline");
  });

  it("hides the door when no child thread exists", async () => {
    await act(async () =>
      root.render(
        <ChatThreadNavigationProvider onOpenThread={vi.fn()}>
          <SpawnReportCard
            agentName="Critic"
            title={null}
            summary="Couldn't finish that step"
            status="failed"
            childThreadId={null}
          />
        </ChatThreadNavigationProvider>,
      ),
    );

    expect(document.querySelector("button")).toBeNull();
    expect(document.body.textContent).not.toContain("Open");
  });
});
