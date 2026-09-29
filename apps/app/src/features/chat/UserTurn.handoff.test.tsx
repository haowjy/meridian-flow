// @vitest-environment jsdom
/** Hand off under a writer message: only once the model has it, never Fork, cutting at that message. */
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
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <div data-markdown>{children}</div>,
}));
vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => () => undefined,
  useProjectDocumentNavigationProjectId: () => null,
}));
vi.mock("@/client/query/useAgentCatalog", () => ({
  useAgentCatalog: () => ({ status: "ready", agents: [critic], refetch: () => undefined }),
}));

const critic: AgentCatalogItem = {
  selection: { catalogEntryId: "entry-critic", definitionRevisionId: "rev-critic" },
  slug: "critic",
  name: "Critic",
  description: "",
  model: "mock",
  ownership: "system",
  unavailableReasons: [],
};

import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type TurnDerivation, TurnDerivationProvider } from "./derivation/DeriveTurnActions";
import { UserTurn } from "./UserTurn";

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

const message = (status: Turn["status"]) =>
  ({
    id: "u-3",
    role: "user",
    status,
    blocks: [
      { id: "b", blockType: "text", sequence: 0, textContent: "Lin Feng reaches the gate." },
    ],
  }) as unknown as Turn;

function derivation(): TurnDerivation {
  return {
    projectId: "project",
    sourceAgent: { name: "General", definitionRevisionId: "rev-general" },
    fork: vi.fn(),
    handoff: vi.fn(),
  };
}

async function render(props: { turn: Turn; queued?: boolean; derivation?: TurnDerivation | null }) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <TurnDerivationProvider
          value={props.derivation === undefined ? derivation() : props.derivation}
        >
          <UserTurn turn={props.turn} queued={props.queued} />
        </TurnDerivationProvider>
      </TooltipProvider>,
    ),
  );
}

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
  );

describe("Hand off on a writer message", () => {
  it("is offered on a delivered message, and Fork is not", async () => {
    await render({ turn: message("complete") });
    expect(button("Hand off from here")).toBeDefined();
    expect(button("Fork from here")).toBeUndefined();
    expect(host.querySelector("[data-user-turn-actions]")).not.toBeNull();
  });

  it("is not offered on a queued message: it sits beyond the cutoff", async () => {
    await render({ turn: message("complete"), queued: true });
    expect(button("Hand off from here")).toBeUndefined();
    expect(host.querySelector("[data-user-turn-actions]")).toBeNull();
  });

  it("is not offered while the message is still sending, or after it failed", async () => {
    await render({ turn: message("pending") });
    expect(button("Hand off from here")).toBeUndefined();
    await render({ turn: message("error") });
    expect(button("Hand off from here")).toBeUndefined();
  });

  it("is not offered where the chat offers no handoff (a subagent's view)", async () => {
    await render({ turn: message("complete"), derivation: null });
    expect(host.querySelector("[data-user-turn-actions]")).toBeNull();
  });

  it("hands off at this message to the Agent the writer picks", async () => {
    const value = derivation();
    await render({ turn: message("complete"), derivation: value });
    const trigger = button("Hand off from here");
    await act(async () => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.click();
    });
    const row = [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
      (candidate) => candidate.textContent?.includes("Critic"),
    );
    await act(async () => row?.click());
    expect(value.handoff).toHaveBeenCalledWith("u-3", {
      selection: critic.selection,
      slug: "critic",
      name: "Critic",
    });
  });
});
