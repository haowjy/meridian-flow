// @vitest-environment jsdom
/** A refused Discard shows on the draft in the composer strip: under it for one document, on its row for several. */

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftDock, type DraftDockModel } from "./DraftDock";
import type { DockRow } from "./docked-drafts";
import type { InlineReviewMessageCode } from "./draft-review-session";

function row(documentId: string): DockRow {
  return {
    documentId,
    documentName: `${documentId}.md`,
    contextPath: `/${documentId}.md`,
    draft: { draftId: `draft-${documentId}` } as DockRow["draft"],
    isNewDocument: true,
  };
}

function dockWith(rows: DockRow[], refused: Record<string, InlineReviewMessageCode>) {
  return {
    generating: false,
    rows,
    serverActiveCount: rows.length,
    aggregateStats: null,
    dispositionRows: [],
    dispositionSnapshot: { items: [] },
    recovery: {},
    mounted: true,
    isBusy: false,
    dispositionError: null,
    rowError: (candidate: DockRow) => refused[candidate.documentId] ?? null,
    reviewRow: vi.fn(),
    openRow: vi.fn(),
    reviewFirst: vi.fn(),
    applyRow: vi.fn(),
    discardRow: vi.fn(),
    startApplyAll: vi.fn(),
    startDiscardAll: vi.fn(),
  } as unknown as DraftDockModel;
}

function renderDock(dock: DraftDockModel, check: (host: HTMLElement) => void) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <DraftDock dock={dock} />
    </I18nProvider>,
    () => check(document.body),
  );
}

describe("DraftDock refused Discard", () => {
  it("shows the error under the strip for one document", async () => {
    await renderDock(dockWith([row("a")], { a: "discard-offline" }), (host) => {
      expect(host.querySelector("[data-draft-dock-disposition-error]")?.textContent).toBe(
        "Couldn't discard. Check your connection and try again.",
      );
    });
  });

  it("opens the strip and shows the error on the refused document's row for several", async () => {
    await renderDock(dockWith([row("a"), row("b")], { b: "discard-offline" }), (host) => {
      const rowError = host.querySelector("[data-draft-dock-row-error]");
      expect(rowError?.textContent).toBe("Couldn't discard. Check your connection and try again.");
      expect(rowError?.previousElementSibling?.textContent).toContain("b.md");
      expect(host.querySelectorAll("[data-draft-dock-row-error]")).toHaveLength(1);
    });
  });

  it("shows nothing when no Discard was refused", async () => {
    await renderDock(dockWith([row("a"), row("b")], {}), (host) => {
      expect(host.querySelector("[role=alert]")).toBeNull();
    });
  });
});
