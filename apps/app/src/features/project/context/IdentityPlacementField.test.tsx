import { act, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { tabLocation } from "./identity-location";

const yDocument = new Y.Doc();
const fragment = yDocument.getXmlFragment("default");
const paragraph = new Y.XmlElement("paragraph");
paragraph.insert(0, [new Y.XmlText("The moonlit bridge trembled beneath her first step.")]);
fragment.insert(0, [paragraph]);

vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({
    getDetached: () => ({ document: yDocument, fragmentName: "default" }),
  }),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...subs: unknown[]) =>
    strings.raw.map((part, index) => part + (subs[index] ?? "")).join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverAnchor: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./file-suggestions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./file-suggestions")>();
  return {
    ...actual,
    useFileSuggestions: () => ({
      suggestions: [
        {
          scheme: "manuscript",
          path: "/Act 1/Scenes",
          name: "Scenes",
          kind: "dir",
          parents: ["Act 1"],
        },
        {
          scheme: "manuscript",
          path: "/Act 1/Scenes/Deep",
          name: "Deep",
          kind: "dir",
          parents: ["Act 1", "Scenes"],
        },
      ],
      isFetching: false,
      isError: false,
    }),
  };
});
vi.mock("./untitled-reconciler-browser", () => ({ clearQueuedIdentityFailure: vi.fn() }));

const { IdentityPlacementField } = await import("./IdentityPlacementField");

const provisionalTab: ContextTab = {
  kind: "new",
  documentId: "doc-new",
  name: "Untitled",
};
const graduatedTab: ContextTab = {
  kind: "tracked",
  documentId: "doc-tracked",
  scheme: "manuscript",
  path: "/Act 1/chapter.md",
  name: "chapter.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

describe("IdentityPlacementField placement ghost", () => {
  it("enters the destination list from the input with ArrowDown", async () => {
    await withReactRoot(
      <IdentityPlacementField
        projectId="project-1"
        activeThreadId={null}
        defaultWorkId={null}
        tab={provisionalTab}
        location={tabLocation(provisionalTab)}
        failure={null}
        commit={vi.fn()}
        onExit={() => {}}
        onOpenExisting={() => {}}
      />,
      async () => {
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="Document name and location"]',
        );
        input?.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
        expect(document.activeElement?.textContent).toBe("Manuscript");
      },
    );
  });

  it.each([
    "Tab",
    "ArrowRight",
  ])("accepts the ghost with %s and leaves the caret at its end", async (key) => {
    await withReactRoot(
      <IdentityPlacementField
        projectId="project-1"
        activeThreadId={null}
        defaultWorkId={null}
        tab={provisionalTab}
        location={tabLocation(provisionalTab)}
        failure={null}
        commit={vi.fn()}
        onExit={() => {}}
        onOpenExisting={() => {}}
      />,
      async () => {
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="Document name and location"]',
        );
        Object.assign(input ?? {}, { attachEvent: () => {}, detachEvent: () => {} });
        window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
        expect(input?.value).toBe("");
        expect(input?.placeholder).toBe("the-moonlit-bridge-trembled-beneath-her");

        await act(async () => {
          input?.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
        });
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

        expect(input?.value).toBe("the-moonlit-bridge-trembled-beneath-her");
        expect(document.activeElement).toBe(input);
        expect(input?.selectionStart).toBe(input?.value.length);
        expect(input?.selectionEnd).toBe(input?.value.length);
      },
    );
  });
});

describe("IdentityPlacementField graduated editing", () => {
  it("opens selected with the current name and offers siblings plus roots", async () => {
    await withReactRoot(
      <IdentityPlacementField
        projectId="project-1"
        activeThreadId={null}
        defaultWorkId={null}
        tab={graduatedTab}
        location={tabLocation(graduatedTab)}
        failure={null}
        commit={vi.fn()}
        onExit={() => {}}
        onOpenExisting={() => {}}
      />,
      async () => {
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="Document name and location"]',
        );
        expect(input?.value).toBe("chapter.md");
        expect(input?.selectionStart).toBe(0);
        expect(input?.selectionEnd).toBe("chapter.md".length);
        expect(document.body.textContent).toContain("Scenes");
        expect(document.body.textContent).toContain("Manuscript");
        expect(document.body.textContent).toContain("Knowledge Base");
      },
    );
  });

  it("browses into nested sibling folders before committing", async () => {
    const commit = vi.fn().mockResolvedValue({ status: "committed" });
    await withReactRoot(
      <IdentityPlacementField
        projectId="project-1"
        activeThreadId={null}
        defaultWorkId={null}
        tab={graduatedTab}
        location={tabLocation(graduatedTab)}
        failure={null}
        commit={commit}
        onExit={() => {}}
        onOpenExisting={() => {}}
      />,
      async () => {
        await act(async () => findButton("Scenes").click());
        expect(document.body.textContent).toContain("Deep");
        await act(async () => findButton("Deep").click());
        expect(document.body.textContent).toContain("Manuscript/Act 1/Scenes/Deep/");
        await act(async () => {
          document
            .querySelector<HTMLInputElement>('input[aria-label="Document name and location"]')
            ?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        expect(commit).toHaveBeenCalledWith({
          destination: {
            scheme: "manuscript",
            folderPath: "/Act 1/Scenes/Deep",
          },
          name: "chapter.md",
        });
      },
    );
  });

  it("keeps a server conflict open with keyboard-reachable Open existing recovery", async () => {
    const openExisting = vi.fn();
    const commit = vi.fn().mockResolvedValue({
      status: "conflict",
      locator: { scheme: "manuscript", path: "/Act 1/existing.md" },
    });
    await withReactRoot(
      <IdentityPlacementField
        projectId="project-1"
        activeThreadId={null}
        defaultWorkId={null}
        tab={graduatedTab}
        location={tabLocation(graduatedTab)}
        failure={null}
        commit={commit}
        onExit={() => {}}
        onOpenExisting={openExisting}
      />,
      async () => {
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="Document name and location"]',
        );
        await act(async () => {
          input?.dispatchEvent(
            new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          );
        });
        const recovery = findButton("Open existing");
        input?.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
        expect(document.activeElement).toBe(recovery);
        await act(async () => recovery.click());
        expect(openExisting).toHaveBeenCalledWith("manuscript", "/Act 1/existing.md");
      },
    );
  });
});

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`missing ${label} button`);
  return button;
}
