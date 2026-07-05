import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { DraftDock } = await import("./DraftDock");

import type { DraftDockModel } from "./DraftDock";
import type { DockRow } from "./docked-drafts";

function draft(input: Partial<ThreadDraftListItem> = {}): ThreadDraftListItem {
  return {
    draftId: "d1",
    documentId: "doc-1",
    documentName: "Chapter 12",
    contextPath: "/chapter-12",
    status: "active",
    lastActorTurnId: null,
    updatedAt: "2026-07-04T00:00:00.000Z",
    appliedAt: null,
    discardedAt: null,
    ...input,
  };
}

function pendingRow(documentId: string, documentName: string): DockRow {
  return {
    documentId,
    documentName,
    contextPath: `/${documentId}`,
    draft: draft({ draftId: `${documentId}-d`, documentId, documentName }),
    state: "pending",
  };
}

function reviewedRow(documentId: string, documentName: string): DockRow {
  return {
    documentId,
    documentName,
    contextPath: `/${documentId}`,
    draft: draft({ draftId: `${documentId}-t`, documentId, documentName, status: "applied" }),
    state: "reviewed",
  };
}

function model(overrides: Partial<DraftDockModel>): DraftDockModel {
  const rows = overrides.rows ?? [];
  const pendingRows = rows.filter((r) => r.state === "pending");
  const reviewedRows = rows.filter((r) => r.state === "reviewed");
  return {
    generating: false,
    rows,
    pendingRows,
    reviewedRows,
    hasPending: pendingRows.length > 0,
    reviewedCount: reviewedRows.length,
    totalCount: rows.length,
    aggregateStats: null,
    mounted: true,
    phase: "settled",
    bulkActive: false,
    inFlightDraftId: null,
    isBusy: false,
    isCannotPlaceRow: () => false,
    reviewRow: vi.fn(),
    reviewFirst: vi.fn(),
    applyRow: vi.fn(),
    discardRow: vi.fn(),
    startApplyAll: vi.fn(),
    startDiscardAll: vi.fn(),
    ...overrides,
  } as DraftDockModel;
}

describe("DraftDock", () => {
  it("renders nothing when unmounted", () => {
    const html = renderToStaticMarkup(<DraftDock dock={model({ mounted: false })} />);
    expect(html).toBe("");
  });

  it("shows the generating strip with muted, non-actionable verbs", () => {
    const html = renderToStaticMarkup(
      <DraftDock
        dock={model({
          phase: "generating",
          generating: true,
          rows: [pendingRow("doc-1", "Chapter 12")],
        })}
      />,
    );
    expect(html).toContain("Editing");
    expect(html).toContain("Apply all");
    // No actionable Review pill while generating.
    expect(html).not.toContain(">Review<");
  });

  it("settled single doc shows Review / Apply / Discard", () => {
    const html = renderToStaticMarkup(
      <DraftDock dock={model({ rows: [pendingRow("doc-1", "Chapter 12")] })} />,
    );
    expect(html).toContain("Chapter 12");
    expect(html).toContain("Review");
    expect(html).toContain("Apply");
    expect(html).toContain("Discard");
    expect(html).not.toContain("Apply all");
  });

  it("settled multi doc collapses to N documents with Apply all", () => {
    const html = renderToStaticMarkup(
      <DraftDock
        dock={model({ rows: [pendingRow("a", "A"), pendingRow("b", "B"), pendingRow("c", "C")] })}
      />,
    );
    expect(html).toContain("3 documents");
    expect(html).toContain("Apply all");
    expect(html).toContain("Discard all");
  });

  it("guided progression drops the strip Review pill and shows K of N reviewed", () => {
    const html = renderToStaticMarkup(
      <DraftDock
        dock={model({
          rows: [reviewedRow("a", "A"), pendingRow("b", "B"), pendingRow("c", "C")],
          reviewedCount: 1,
          totalCount: 3,
        })}
      />,
    );
    expect(html).toContain("1 of 3 reviewed");
  });

  it("terminal phase flashes All changes reviewed", () => {
    const html = renderToStaticMarkup(<DraftDock dock={model({ phase: "terminal", rows: [] })} />);
    expect(html).toContain("All changes reviewed");
  });
});
