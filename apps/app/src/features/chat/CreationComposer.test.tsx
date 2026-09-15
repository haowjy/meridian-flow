// @vitest-environment jsdom
/** Persisted choices must be validated before new attempts, never before immutable reconciliation. */
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { CreationComposer } from "./CreationComposer";

const fixture = vi.hoisted(() => ({
  agentStatus: "loading",
  locked: false,
  issue: "refused",
  retry: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("./useCreationComposer", () => ({
  useCreationComposer: () => ({
    state: {
      slot: { choices: { agentSlug: "removed-agent", workId: null } },
      issue: fixture.issue,
    },
    loaded: true,
    contextLocked: fixture.locked,
    retry: fixture.retry,
  }),
}));
vi.mock("@/client/query/useWorks", () => ({ useWorks: () => ({ status: "empty", works: [] }) }));
vi.mock("@/client/query/useProjectAgents", () => ({
  useProjectAgents: () => ({
    status: fixture.agentStatus,
    agents: [],
    isError: fixture.agentStatus === "error",
  }),
}));
vi.mock("@/features/editor/references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: () => null,
}));
vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => vi.fn(),
}));
vi.mock("@/features/project/home/NewThreadComposerToolbar", () => ({
  NewThreadComposerToolbar: () => null,
}));
vi.mock("@/components/app/composer", () => ({
  Composer: ({ submitDisabled }: { submitDisabled: boolean }) => (
    <button type="button" disabled={submitDisabled}>
      Send
    </button>
  ),
}));

afterEach(() => {
  fixture.locked = false;
  fixture.issue = "refused";
  vi.clearAllMocks();
});
it.each([
  "loading",
  "error",
  "empty",
])("requires correction/readiness before new submit or refused retry when Agents are %s", async (status) => {
  fixture.agentStatus = status;
  await withReactRoot(<CreationComposer projectId="project" />, async () => {
    const buttons = [...document.querySelectorAll("button")];
    expect(buttons.find((button) => button.textContent === "Send")?.disabled).toBe(true);
    expect(buttons.some((button) => button.textContent === "Retry")).toBe(false);
  });
});
it("still reconciles a locked ambiguous attempt when its Agent catalog cannot load", async () => {
  fixture.agentStatus = "error";
  fixture.locked = true;
  fixture.issue = "ambiguous";
  await withReactRoot(<CreationComposer projectId="project" />, async () => {
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(fixture.retry).toHaveBeenCalledOnce();
  });
});
