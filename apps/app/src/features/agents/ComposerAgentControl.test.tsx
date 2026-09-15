// @vitest-environment jsdom
/** Real Agent adapter integration with the toolbar-owned page/focus contract. */
import type { AgentCatalogItem } from "@meridian/contracts/agents";
import { act, createRef, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentCatalogStatus } from "@/client/query/useAgentCatalog";
import {
  ComposerToolbar,
  type ComposerToolbarControl,
  createComposerToolbarModel,
} from "@/components/app/composer-toolbar";
import { setTestToolbarInlineIds } from "@/components/app/composer-toolbar/composer-toolbar-test-harness";
import { useComposerAgentToolbarControl } from "./ComposerAgentControl";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
let catalog: AgentCatalogStatus;
vi.mock("@/client/query/useAgentCatalog", () => ({ useAgentCatalog: () => catalog }));
vi.mock("@/components/app/composer-toolbar/useMeasuredComposerToolbar", async () => ({
  useMeasuredComposerToolbar: (
    await import("@/components/app/composer-toolbar/composer-toolbar-test-harness")
  ).useTestMeasuredComposerToolbar,
}));

const refetch = vi.fn();
const status = (
  value: AgentCatalogStatus["status"],
  agents: AgentCatalogItem[] | null,
): AgentCatalogStatus => ({
  status: value,
  agents,
  data: agents,
  isError: value === "error",
  isFetching: value === "loading",
  refetch,
});
const general: AgentCatalogItem = {
  slug: "general",
  name: "General",
  description: "General fiction support",
  ownership: "system",
  unavailableReasons: [],
  selection: { catalogEntryId: "general-entry", definitionRevisionId: "general-revision" },
};
const prose: AgentCatalogItem = {
  slug: "prose",
  name: "Prose",
  description: "Line-level prose",
  ownership: "personal",
  unavailableReasons: [],
  selection: { catalogEntryId: "prose-entry", definitionRevisionId: "prose-revision" },
};
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const competingControl = (): ComposerToolbarControl => {
  const choice = createRef<HTMLButtonElement>();
  return {
    kind: "panel",
    id: "work",
    priority: 200,
    interaction: "enabled",
    item: { ariaLabel: "Work", label: "Work" },
    inline: ({ trigger }) => (
      <button ref={trigger.ref} {...trigger.buttonProps} type="button" aria-label="Work">
        Work
      </button>
    ),
    panel: {
      ariaLabel: "Work",
      size: "compact",
      focus: {
        pageId: "ready",
        repairRevision: "ready",
        candidates: [{ key: "lock", ref: choice }],
        fallback: "content",
      },
      render: ({ beginBlocking }) => (
        <button ref={choice} type="button" onClick={beginBlocking}>
          Lock work
        </button>
      ),
    },
  };
};

function Harness({
  mode,
  competing = false,
  onSelect = vi.fn(),
}: {
  mode: "interactive" | "readonly";
  competing?: boolean;
  onSelect?: (agent: Pick<AgentCatalogItem, "name" | "slug" | "selection">) => void;
}) {
  const control = useComposerAgentToolbarControl(
    mode === "interactive"
      ? { mode, selectedAgent: general, onSelectedAgentChange: onSelect }
      : { mode, name: "General" },
  );
  return (
    <ComposerToolbar
      model={createComposerToolbarModel(competing ? [control, competingControl()] : [control])}
      ariaLabel="Options"
    />
  );
}

describe("useComposerAgentToolbarControl", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    refetch.mockClear();
    setTestToolbarInlineIds("all");
  });

  it("owns loading, ready, error, and interactive-to-readonly focus destinations", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    catalog = status("loading", null);
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness mode="interactive" />
        </StrictMode>,
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Agent: General"]');
    expect(trigger?.textContent).toBe("General");
    expect(trigger?.className).toContain("max-w-[11rem]");
    await act(async () => trigger?.click());
    const content = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(document.activeElement).toBe(content);

    catalog = status("ready", [general, prose]);
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness mode="interactive" />
        </StrictMode>,
      ),
    );
    expect(document.activeElement?.textContent).toContain("General");

    catalog = status("error", []);
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness mode="interactive" />
        </StrictMode>,
      ),
    );
    expect(document.activeElement?.textContent).toBe("Retry");

    await act(async () =>
      root.render(
        <StrictMode>
          <Harness mode="readonly" />
        </StrictMode>,
      ),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const readonly = document.querySelector<HTMLButtonElement>('[aria-label="Agent: General"]');
    expect(document.activeElement).toBe(readonly);
    expect(readonly?.hasAttribute("aria-haspopup")).toBe(false);
    await act(async () => root.unmount());
  });

  it("distinguishes same-slug entries and disables unsupported revisions", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const personal = {
      ...general,
      name: "Personal General",
      ownership: "personal" as const,
      selection: { catalogEntryId: "personal-general", definitionRevisionId: "personal-v1" },
    };
    const unavailable = { ...prose, unavailableReasons: ["Model unavailable"] };
    catalog = status("ready", [general, personal, unavailable]);
    const onSelect = vi.fn();
    await act(async () => root.render(<Harness mode="interactive" onSelect={onSelect} />));
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Agent: General"]')?.click(),
    );
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    const disabled = choices.find((button) => button.textContent?.includes("Model unavailable"));
    expect(disabled?.disabled).toBe(true);
    await act(async () => disabled?.click());
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () =>
      choices.find((button) => button.textContent?.includes("Personal General"))?.click(),
    );
    expect(onSelect).toHaveBeenCalledWith({
      name: personal.name,
      slug: "general",
      selection: personal.selection,
    });
    await act(async () => root.unmount());
  });

  it("preserves toolbar-owned Agent semantics during a competing lock", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    catalog = status("ready", [general, prose]);
    await act(async () => root.render(<Harness mode="interactive" competing />));
    const work = document.querySelector<HTMLButtonElement>('[aria-label="Work"]');
    await act(async () => work?.click());
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Lock work")
        ?.click();
    });
    const agent = document.querySelector<HTMLButtonElement>('[aria-label="Agent: General"]');
    expect(agent?.getAttribute("aria-disabled")).toBe("true");
    expect(agent?.disabled).toBe(false);
    await act(async () => agent?.click());
    expect(document.querySelector('[aria-label="Work"][role="dialog"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("opens the real Agent adapter from the overflow root and returns to its row", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    catalog = status("ready", [general, prose]);
    setTestToolbarInlineIds([]);
    await act(async () => root.render(<Harness mode="interactive" />));
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="More composer controls"]')?.click(),
    );
    const row = document.querySelector<HTMLButtonElement>(
      '[aria-label="Choose agent, currently General"]',
    );
    await act(async () => row?.click());
    expect(document.activeElement?.textContent).toContain("General");
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Back")
        ?.click(),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Choose agent, currently General",
    );
    await act(async () => root.unmount());
  });
});
