import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { DraftReviewController } from "./useDraftReviewController";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
    Array.isArray(strings)
      ? strings.reduce((out, part, i) => out + part + String(values[i] ?? ""), "")
      : String(strings),
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/client/query/useDraftPreview", () => ({
  useDraftPreview: () => ({
    preview: {
      status: "active",
      draftId: "draft-1",
      live: "The old line.",
      preview: "The new line.",
      liveRevisionToken: 3,
      draftRevisionToken: 7,
      inlineModelPresent: false,
    },
    isFetching: false,
    isError: false,
    refetch: () => undefined,
  }),
}));

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html: string,
  ) => {
    window: Window & typeof globalThis & { close: () => void };
  };
};

const { DraftDiffPanel } = await import("./DraftDiffPanel");

function controllerStub(overrides: Partial<DraftReviewController> = {}): DraftReviewController {
  return {
    projectId: "project-1",
    workId: "work-1",
    threadId: "thread-1",
    overlap: null,
    staleDraft: null,
    staleDraftMessage: null,
    cannotPlaceDraft: null,
    cannotPlaceDraftMessage: null,
    isPending: false,
    isAccepting: false,
    isRejecting: false,
    accept: vi.fn(),
    reject: vi.fn(),
    ...overrides,
  } as unknown as DraftReviewController;
}

function renderPanel(controller: DraftReviewController, run: (rootNode: HTMLElement) => void) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const rootNode = dom.window.document.getElementById("root");
    if (!rootNode) throw new Error("missing root");
    const root = createRoot(rootNode);
    act(() => {
      root.render(<DraftDiffPanel controller={controller} documentId="doc-1" draftId="draft-1" />);
    });
    run(rootNode);
    act(() => root.unmount());
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

function buttonByText(rootNode: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(rootNode.querySelectorAll("button")).find(
      (button): button is HTMLButtonElement => button.textContent === text,
    ) ?? null
  );
}

describe("DraftDiffPanel cannot_place terminal state", () => {
  const cannotPlaceController = () =>
    controllerStub({
      cannotPlaceDraft: { documentId: "doc-1", draftId: "draft-1" },
      cannotPlaceDraftMessage:
        "The document changed, so this draft can’t be placed automatically. Copy the text you need, or discard the draft.",
    });

  it("renders the calm terminal banner with a dead Apply and a Copy affordance", () => {
    renderPanel(cannotPlaceController(), (rootNode) => {
      expect(rootNode.textContent).toContain("can’t be placed automatically");
      expect(rootNode.textContent).toContain("Can't place");

      const apply = buttonByText(rootNode, "Apply draft");
      expect(apply).not.toBeNull();
      expect(apply?.disabled).toBe(true);

      const discard = buttonByText(rootNode, "Discard draft");
      expect(discard?.disabled).toBe(false);

      expect(buttonByText(rootNode, "Copy draft")).not.toBeNull();
    });
  });

  it("never re-fires the impossible apply but keeps Discard working", () => {
    const controller = cannotPlaceController();
    renderPanel(controller, (rootNode) => {
      const window = globalThis.window;
      const apply = buttonByText(rootNode, "Apply draft");
      act(() => {
        apply?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(controller.accept).not.toHaveBeenCalled();

      const discard = buttonByText(rootNode, "Discard draft");
      act(() => {
        discard?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(controller.reject).toHaveBeenCalledWith("doc-1", "draft-1");
    });
  });

  it("keeps Apply live and hides the terminal banner for a healthy draft", () => {
    renderPanel(controllerStub(), (rootNode) => {
      expect(rootNode.textContent).not.toContain("Can't place");
      expect(buttonByText(rootNode, "Apply draft")?.disabled).toBe(false);
      expect(buttonByText(rootNode, "Copy draft")).toBeNull();
    });
  });

  it("does not treat a different draft's terminal state as this panel's", () => {
    renderPanel(
      controllerStub({
        cannotPlaceDraft: { documentId: "doc-1", draftId: "draft-other" },
        cannotPlaceDraftMessage: "The document changed.",
      }),
      (rootNode) => {
        expect(rootNode.textContent).not.toContain("Can't place");
        expect(buttonByText(rootNode, "Apply draft")?.disabled).toBe(false);
      },
    );
  });
});
