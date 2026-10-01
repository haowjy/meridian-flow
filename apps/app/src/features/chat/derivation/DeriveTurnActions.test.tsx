// @vitest-environment jsdom
/** Fork and Hand off in the turn actions: only in a primary chat, cutting at the chosen turn. */
import type { AgentCatalogItem } from "@meridian/contracts/agents";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((out, part, index) => out + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
const catalog = vi.hoisted(() => ({ agents: [] as AgentCatalogItem[] }));
vi.mock("@/client/query/useAgentCatalog", () => ({
  useAgentCatalog: () => ({ status: "ready", agents: catalog.agents, refetch: () => undefined }),
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  canDeriveFrom,
  DeriveTurnActions,
  defaultHandoffAgent,
  type TurnDerivation,
  TurnDerivationProvider,
} from "./DeriveTurnActions";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const agent = (name: string, revision: string): AgentCatalogItem => ({
  selection: { catalogEntryId: `entry-${name}`, definitionRevisionId: revision },
  slug: name.toLowerCase(),
  name,
  description: "",
  model: "mock",
  ownership: "system",
  unavailableReasons: [],
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  catalog.agents = [agent("Critic", "rev-critic"), agent("General", "rev-general")];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

function derivation(): TurnDerivation {
  return {
    projectId: "project",
    sourceAgent: { name: "General", definitionRevisionId: "rev-general" },
    fork: vi.fn(),
    handoff: vi.fn(),
  };
}

async function render(value: TurnDerivation | null) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <TurnDerivationProvider value={value}>
          <DeriveTurnActions turnId="turn-7" />
        </TurnDerivationProvider>
      </TooltipProvider>,
    ),
  );
}

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
  );

describe("canDeriveFrom", () => {
  it("offers the actions only in a primary chat the server already has", () => {
    expect(canDeriveFrom({ kind: "primary", pendingCreation: false, canOpen: true })).toBe(true);
    expect(canDeriveFrom({ kind: "subagent", pendingCreation: false, canOpen: true })).toBe(false);
    expect(canDeriveFrom({ kind: "primary", pendingCreation: true, canOpen: true })).toBe(false);
    expect(canDeriveFrom({ kind: null, pendingCreation: false, canOpen: true })).toBe(false);
  });
});

describe("DeriveTurnActions", () => {
  it("renders nothing without a derivation (a subagent's view)", async () => {
    await render(null);
    expect(button("Fork from here")).toBeUndefined();
    expect(button("Hand off from here")).toBeUndefined();
  });

  it("forks at the chosen turn with no Agent choice", async () => {
    const value = derivation();
    await render(value);
    await act(async () => button("Fork from here")?.click());
    expect(value.fork).toHaveBeenCalledWith("turn-7");
  });

  it("hands off to the Agent the writer picks, with the source's Agent preselected", async () => {
    const value = derivation();
    await render(value);
    const trigger = button("Hand off from here");
    await act(async () => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.click();
    });
    await act(
      async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
    );
    const general = [...document.querySelectorAll("button[aria-pressed]")].find((row) =>
      row.textContent?.includes("General"),
    );
    expect(general?.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(general);
    const critic = [...document.querySelectorAll("button[aria-pressed]")].find((row) =>
      row.textContent?.includes("Critic"),
    ) as HTMLButtonElement | undefined;
    await act(async () => critic?.click());
    expect(value.handoff).toHaveBeenCalledWith("turn-7", {
      selection: { catalogEntryId: "entry-Critic", definitionRevisionId: "rev-critic" },
      slug: "critic",
      name: "Critic",
    });
  });
});

describe("the handoff picker", () => {
  it("closes on one Escape, even while a focused row shows its tooltip", async () => {
    const value = derivation();
    await render(value);
    const trigger = button("Hand off from here");
    await act(async () => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.click();
    });
    await act(
      async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
    );
    expect(document.querySelector('[aria-label="Hand off to an Agent"]')).not.toBeNull();
    const critic = [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
      (row) => row.textContent?.includes("Critic"),
    );
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
      critic?.focus();
    });
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.querySelector('[aria-label="Hand off to an Agent"]')).toBeNull();
    expect(value.handoff).not.toHaveBeenCalled();
  });
});

describe("the picker's row tooltips", () => {
  it("wait for the writer to move through the list, not the focus the picker lands on open", async () => {
    await render(derivation());
    const trigger = button("Hand off from here");
    await act(async () => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.click();
    });
    await act(
      async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
    );
    const rows = [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
    expect(document.activeElement?.textContent).toContain("General");
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    // Shift+Tab to the row above: now the writer is reading the list.
    const general = rows.find((row) => row.textContent?.includes("General"));
    const critic = rows.find((row) => row.textContent?.includes("Critic"));
    await act(async () => {
      general?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
      critic?.focus();
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Critic (mock)");
  });
});

describe("defaultHandoffAgent", () => {
  it("prefers the source's own revision, then its Agent by name", () => {
    const agents = [agent("General", "rev-new"), agent("Critic", "rev-critic")];
    expect(
      defaultHandoffAgent(agents, { name: "Critic", definitionRevisionId: "rev-critic" })?.name,
    ).toBe("Critic");
    expect(
      defaultHandoffAgent(agents, { name: "General", definitionRevisionId: "rev-old" })?.name,
    ).toBe("General");
    expect(defaultHandoffAgent(agents, { name: "Gone", definitionRevisionId: null })).toBeNull();
  });
});
