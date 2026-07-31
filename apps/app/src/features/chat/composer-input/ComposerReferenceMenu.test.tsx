/**
 * What a screen reader hears in the composer's `@` rows.
 *
 * Once a query narrows the list the group headings go, and the icon is the
 * only visible kind — which a screen reader cannot see. The sr-only kind word
 * on each row is then the whole difference between `gate` the chapter and
 * `gate-map.png` the picture. The editor's rows carry the same sentence
 * (`reference-rows.tsx`); the composer's copy lost it once already, which is
 * why this suite exists.
 */
import { describe, expect, it, vi } from "vitest";

import { createSuggestionMenu } from "@/core/completion";
import { withReactRoot } from "@/test-support/react-dom-harness";

import { ComposerReferenceMenu } from "./ComposerReferenceMenu";
import type { ComposerReferenceItem } from "./composer-reference-suggestion";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + String(values[index - 1] ?? "") + part),
}));

const chapter: ComposerReferenceItem = {
  kind: "document",
  key: "document:gate",
  name: "The Third Gate",
  location: "Chapters",
  documentId: "doc-gate",
  uri: "manuscript://chapters/the-third-gate.md",
  matchedAlias: null,
  ambiguous: false,
};

const mapImage: ComposerReferenceItem = {
  kind: "asset",
  key: "asset:gate-map",
  name: "gate-map.png",
  location: "Assets",
  assetDocumentId: "asset-gate-map",
  path: "/assets/gate-map.png",
  fileType: "image",
  uri: "manuscript://assets/gate-map.png",
};

const appendixPdf: ComposerReferenceItem = {
  kind: "asset",
  key: "asset:appendix",
  name: "appendix.pdf",
  location: "Assets",
  assetDocumentId: "asset-appendix",
  path: "/assets/appendix.pdf",
  fileType: "pdf",
  uri: "manuscript://assets/appendix.pdf",
};

describe("the sr-only kind on every row", () => {
  it("names each row's kind while a typed query hides the group headings", async () => {
    const { menu, controller } = createSuggestionMenu<ComposerReferenceItem>();
    controller.open({
      items: [chapter, mapImage, appendixPdf],
      // Non-empty: exactly the state where no visible heading says the kind.
      query: "gate",
      anchorRect: () => new window.DOMRect(24, 300, 200, 16),
      label: "Reference a document",
      meta: null,
      choose: () => {},
      dismiss: () => {},
    });

    await withReactRoot(
      <ComposerReferenceMenu
        id="composer-reference-menu"
        menu={menu}
        snapshot={menu.snapshot()}
        frameRef={{ current: null }}
      />,
      () => {
        const rows = new Map(
          [...document.querySelectorAll('[role="option"]')].map((row) => [
            row.textContent ?? "",
            row,
          ]),
        );
        const spoken = (name: string) => [...rows.keys()].find((text) => text.includes(name)) ?? "";

        expect(rows.size).toBe(3);
        expect(spoken("The Third Gate")).toContain("document");
        expect(spoken("gate-map.png")).toContain("picture");
        expect(spoken("appendix.pdf")).toContain("file");
      },
    );
  });
});
