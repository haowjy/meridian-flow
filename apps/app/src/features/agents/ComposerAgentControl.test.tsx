// @vitest-environment jsdom
/** Real Agent adapter integration with the toolbar-owned page/focus contract. */
import type { ProjectAgentSummary } from "@meridian/contracts/agents";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectAgentsStatus } from "@/client/query/useProjectAgents";
import { ComposerToolbar, createComposerToolbarModel } from "@/components/app/composer-toolbar";
import { useComposerAgentToolbarControl } from "./ComposerAgentControl";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
let catalog: ProjectAgentsStatus;
vi.mock("@/client/query/useProjectAgents", () => ({ useProjectAgents: () => catalog }));
vi.mock("@/components/app/composer-toolbar/useMeasuredComposerToolbar", async () => {
  const { useLayoutEffect, useRef } = await import("react");
  return {
    useMeasuredComposerToolbar: (
      controls: readonly { id: string }[],
      onLayout: (layout: {
        inlineIds: string[];
        overflowIds: string[];
        constrained: boolean;
      }) => void,
    ) => {
      const root = useRef<HTMLFieldSetElement | null>(null);
      const probe = useRef<HTMLButtonElement | null>(null);
      useLayoutEffect(
        () =>
          onLayout({
            inlineIds: controls.map(({ id }) => id),
            overflowIds: [],
            constrained: false,
          }),
        [controls, onLayout],
      );
      return { root, probe, controlRef: () => () => {} };
    },
  };
});

const refetch = vi.fn();
const status = (
  value: ProjectAgentsStatus["status"],
  agents: ProjectAgentSummary[] | null,
): ProjectAgentsStatus => ({
  status: value,
  agents,
  data: agents,
  isError: value === "error",
  isFetching: value === "loading",
  refetch,
});
const general: ProjectAgentSummary = {
  slug: "general",
  name: "General",
  description: "General fiction support",
  source: "builtin",
  packageName: null,
};
const prose: ProjectAgentSummary = {
  slug: "prose",
  name: "Prose",
  description: "Line-level prose",
  source: "user",
  packageName: null,
};
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function Harness({ mode }: { mode: "interactive" | "readonly" }) {
  const control = useComposerAgentToolbarControl(
    mode === "interactive"
      ? { projectId: "project", mode, selectedSlug: "general", onSelectedSlugChange: vi.fn() }
      : { projectId: "project", mode, selectedSlug: "general" },
  );
  return <ComposerToolbar model={createComposerToolbarModel([control])} ariaLabel="Options" />;
}

describe("useComposerAgentToolbarControl", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    refetch.mockClear();
  });

  it("owns loading, ready, error, and interactive-to-readonly focus destinations", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    catalog = status("loading", null);
    await act(async () => root.render(<Harness mode="interactive" />));
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Agent: General"]');
    await act(async () => trigger?.click());
    const content = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(document.activeElement).toBe(content);

    catalog = status("ready", [general, prose]);
    await act(async () => root.render(<Harness mode="interactive" />));
    expect(document.activeElement?.textContent).toContain("General");

    catalog = status("error", []);
    await act(async () => root.render(<Harness mode="interactive" />));
    expect(document.activeElement?.textContent).toBe("Retry");

    await act(async () => root.render(<Harness mode="readonly" />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const readonly = document.querySelector<HTMLButtonElement>('[aria-label="Agent: General"]');
    expect(document.activeElement).toBe(readonly);
    expect(readonly?.hasAttribute("aria-haspopup")).toBe(false);
    await act(async () => root.unmount());
  });
});
