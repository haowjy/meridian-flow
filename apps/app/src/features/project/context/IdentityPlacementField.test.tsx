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
    useFileSuggestions: () => ({ suggestions: [], isFetching: false, isError: false }),
  };
});
vi.mock("./untitled-reconciler-browser", () => ({ clearQueuedIdentityFailure: vi.fn() }));

const { IdentityPlacementField } = await import("./IdentityPlacementField");

const provisionalTab: ContextTab = {
  kind: "new",
  documentId: "doc-new",
  name: "Untitled",
};

describe("IdentityPlacementField placement ghost", () => {
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
