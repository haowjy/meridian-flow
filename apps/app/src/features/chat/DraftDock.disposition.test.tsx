/** Writer-visible project recovery identity and terminal-copy proofs. */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DraftDock, type DraftDockModel } from "./DraftDock";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

function dockFor(outcome: "live-ready" | "writer-abandoned"): DraftDockModel {
  const identity = {
    accountId: "account-1",
    projectId: "project-1",
    workId: "work-elsewhere",
    documentId: "doc-1",
    draftId: "draft-1",
  };
  const item = {
    kind: "server-applied-awaiting-live" as const,
    identity,
    entryVersion: 2,
    presentation: {
      documentName: "Elsewhere chapter",
      contextPath: "chapter.md",
      owningWorkLabel: "Other Work",
    },
    obligations: { draftTab: { kind: "none" as const }, branch: { kind: "none" as const } },
    origin: { kind: "local-response" as const },
    phase: {
      kind: "disposing" as const,
      dispositionToken: 3,
      outcome,
      effects: { context: "pending" as const },
      lastFailure: "effect-failed" as const,
    },
  };
  return {
    generating: false,
    rows: [],
    serverActiveCount: 0,
    aggregateStats: null,
    dispositionRows: [
      {
        kind: "recovery",
        recovery: { identity, entryVersion: 2 },
        presentation: item.presentation,
        phase: item.phase,
      },
    ],
    dispositionSnapshot: {
      nextVersion: 4,
      reservations: [],
      items: [item],
      appliedSuppressions: [],
      remoteDraftWitnesses: [],
    },
    recovery: {
      awaitInitialOutcome: vi.fn(),
      retry: vi.fn(),
      abandon: vi.fn(),
      finishDisposition: vi.fn(),
      checkApplyOutcome: vi.fn(),
      matchingHostMounted: vi.fn(),
    },
    mounted: true,
    isBusy: false,
    dispositionError: null,
    reviewRow: vi.fn(),
    openRow: vi.fn(),
    reviewFirst: vi.fn(),
    applyRow: vi.fn(),
    discardRow: vi.fn(),
    startApplyAll: vi.fn(),
    startDiscardAll: vi.fn(),
  };
}

describe("DraftDock recovery disposition", () => {
  it("labels project recovery with its non-current owning Work", () => {
    expect(renderToStaticMarkup(<DraftDock dock={dockFor("live-ready")} />)).toContain(
      "Other Work",
    );
  });

  it("renders Finishing close and Finish close for writer abandonment", () => {
    const markup = renderToStaticMarkup(<DraftDock dock={dockFor("writer-abandoned")} />);
    expect(markup).toContain("Finishing close");
    expect(markup).toContain("Finish close");
    expect(markup).not.toContain("Finish reopening");
  });

  it("renders Finishing reopening and Finish reopening for live readiness", () => {
    const markup = renderToStaticMarkup(<DraftDock dock={dockFor("live-ready")} />);
    expect(markup).toContain("Finishing reopening");
    expect(markup).toContain("Finish reopening");
    expect(markup).not.toContain("Finish close");
  });
});
