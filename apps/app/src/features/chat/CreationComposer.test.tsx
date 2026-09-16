// @vitest-environment jsdom
/** Home Send has no first-send recovery copy. */
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { CreationComposer } from "./CreationComposer";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("./useCreationComposer", () => ({
  useCreationComposer: () => ({
    state: { slot: { choices: {} }, issue: null, editorEpoch: 0 },
    loaded: true,
    busy: false,
    submitLocked: false,
    contextLocked: false,
    updateChoices: vi.fn(),
    updateDraft: vi.fn(),
    submit: vi.fn(),
  }),
}));
vi.mock("@/client/query/useWorks", () => ({ useWorks: () => ({ status: "empty", works: [] }) }));
vi.mock("@/client/query/useAgentCatalog", () => ({
  useAgentCatalog: () => ({
    status: "ready",
    agents: [
      {
        ownership: "system",
        slug: "general",
        name: "General",
        selection: { catalogEntryId: "general", definitionRevisionId: "rev" },
        unavailableReasons: [],
      },
    ],
    isError: false,
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

afterEach(() => vi.clearAllMocks());

it("does not show first-send recovery copy", async () => {
  await withReactRoot(<CreationComposer projectId="project" />, async () => {
    expect(document.body.textContent).not.toContain("Continue the saved creation attempt.");
    expect(document.body.textContent).not.toContain("Saved first message");
    expect(document.body.textContent).not.toContain("Check status");
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Send"),
    ).toBe(true);
  });
});
