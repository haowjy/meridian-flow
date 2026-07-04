import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { DraftReviewController } from "./useDraftReviewController";

const previewState = vi.hoisted(() => ({ current: null as unknown }));

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
    preview: previewState.current,
    isFetching: false,
    isError: false,
    refetch: () => undefined,
  }),
}));

const ACTIVE_PREVIEW = {
  status: "active",
  draftId: "draft-1",
  live: "The old line.",
  preview: "The new line.",
  liveRevisionToken: 3,
  draftRevisionToken: 7,
  inlineModelPresent: false,
};

beforeEach(() => {
  previewState.current = ACTIVE_PREVIEW;
});

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
    isPending: false,
    isAccepting: false,
    isRejecting: false,
    accept: vi.fn(),
    reject: vi.fn(),
    ...overrides,
  } as unknown as DraftReviewController;
}

async function renderPanel(
  controller: DraftReviewController,
  run: (rootNode: HTMLElement, clipboardWrite: Mock) => void | Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  try {
    const rootNode = dom.window.document.getElementById("root");
    if (!rootNode) throw new Error("missing root");
    const root = createRoot(rootNode);
    act(() => {
      root.render(<DraftDiffPanel controller={controller} documentId="doc-1" draftId="draft-1" />);
    });
    await run(rootNode, clipboardWrite);
    act(() => root.unmount());
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
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
    });

  it("renders the neutral terminal banner and removes Apply from the footer", async () => {
    await renderPanel(cannotPlaceController(), (rootNode) => {
      expect(rootNode.textContent).toContain("can’t be placed automatically");
      expect(rootNode.textContent).toContain("Copy the text you need, or discard the draft.");
      expect(rootNode.textContent).toContain("Can't place");

      // Terminal means no Apply at all — a disabled primary would promise a
      // retry that can never happen.
      expect(buttonByText(rootNode, "Apply draft")).toBeNull();

      // Neutral dead-card skin, not the jade accept-confirm tint.
      const banner = rootNode.querySelector('[role="status"]');
      expect(banner?.className).toContain("bg-surface-subtle");
      expect(banner?.className).toContain("border-border-subtle");
      expect(banner?.className).not.toContain("bg-primary/10");
      expect(banner?.querySelector("p")?.className).toContain("text-muted-foreground");
      expect(banner?.querySelector("p")?.className).not.toContain("text-jade-text");

      // Recovery pair: inline Copy in the banner, Copy draft + Discard in
      // the footer.
      expect(buttonByText(rootNode, "Copy")).not.toBeNull();
      expect(buttonByText(rootNode, "Copy draft")).not.toBeNull();
      expect(buttonByText(rootNode, "Discard draft")?.disabled).toBe(false);
    });
  });

  it("copies the merged preview and keeps Discard working", async () => {
    const controller = cannotPlaceController();
    await renderPanel(controller, async (rootNode, clipboardWrite) => {
      const window = globalThis.window;
      const copy = buttonByText(rootNode, "Copy draft");
      await act(async () => {
        copy?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(clipboardWrite).toHaveBeenCalledWith("The new line.");
      expect(copy?.textContent).toBe("Copied");

      const discard = buttonByText(rootNode, "Discard draft");
      act(() => {
        discard?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(controller.reject).toHaveBeenCalledWith("doc-1", "draft-1");
      expect(controller.accept).not.toHaveBeenCalled();
    });
  });

  it("hides Copy and drops the copy clause when there is nothing to copy", async () => {
    previewState.current = null;
    await renderPanel(cannotPlaceController(), (rootNode) => {
      expect(rootNode.textContent).toContain("can’t be placed automatically. Discard the draft.");
      expect(rootNode.textContent).not.toContain("Copy the text");
      expect(buttonByText(rootNode, "Copy")).toBeNull();
      expect(buttonByText(rootNode, "Copy draft")).toBeNull();
      expect(buttonByText(rootNode, "Apply draft")).toBeNull();
      expect(buttonByText(rootNode, "Discard draft")?.disabled).toBe(false);
    });
  });

  it("keeps Apply live and hides the terminal banner for a healthy draft", async () => {
    await renderPanel(controllerStub(), (rootNode) => {
      expect(rootNode.textContent).not.toContain("Can't place");
      expect(buttonByText(rootNode, "Apply draft")?.disabled).toBe(false);
      expect(buttonByText(rootNode, "Copy draft")).toBeNull();
    });
  });

  it("does not treat a different draft's terminal state as this panel's", async () => {
    await renderPanel(
      controllerStub({
        cannotPlaceDraft: { documentId: "doc-1", draftId: "draft-other" },
      }),
      (rootNode) => {
        expect(rootNode.textContent).not.toContain("Can't place");
        expect(buttonByText(rootNode, "Apply draft")?.disabled).toBe(false);
      },
    );
  });
});
