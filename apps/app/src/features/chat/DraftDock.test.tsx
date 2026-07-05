import { createRequire } from "node:module";
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DraftReviewContextValue } from "./DraftReviewProvider";
import type { DraftReviewController } from "./useDraftReviewController";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { contextRef, openAiDraftMock } = vi.hoisted(() => ({
  contextRef: { current: null as DraftReviewContextValue | null },
  openAiDraftMock: vi.fn(),
}));

vi.mock("./DraftReviewProvider", () => ({
  useDraftReview: () => {
    if (!contextRef.current) throw new Error("missing draft review context");
    return contextRef.current;
  },
  reviewableDraftsFromGroup: (group: { drafts?: ThreadDraftListItem[] } | null | undefined) => {
    const visible = group?.drafts ?? [];
    return { visible, active: visible.filter((draft) => draft.status === "active") };
  },
}));
vi.mock("./useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft: openAiDraftMock }),
}));
const { DraftDock, useDraftDock } = await import("./DraftDock");

import type { DraftDockModel } from "./DraftDock";
import type { DockRow } from "./docked-drafts";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close: () => void } };
};

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
    wordsAdded: null,
    wordsRemoved: null,
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

function controller(overrides: Partial<DraftReviewController> = {}): DraftReviewController {
  return {
    projectId: "project-1",
    workId: "work-1",
    threadId: "thread-1",
    inlineReview: null,
    overlap: null,
    staleDraft: null,
    staleDraftMessage: null,
    cannotPlaceDraft: null,
    isAccepting: false,
    isRejecting: false,
    isPending: false,
    isInlineDiscardPending: false,
    pendingInlineDiscardIds: () => new Set(),
    cannotPlaceInlineOperationIds: () => new Set(),
    confirmingAcceptOperationId: null,
    confirmingDiscardOperationId: null,
    inlineReviewMessage: null,
    inlineDiscardError: null,
    isOperationAccepting: false,
    isOperationUndoing: false,
    enterInlineReview: vi.fn(),
    exitInlineReview: vi.fn(),
    exitReview: vi.fn(),
    inlineReviewModelAvailable: vi.fn(),
    setInlineReviewRuntime: vi.fn(),
    confirmAcceptOperation: vi.fn(),
    cancelAcceptOperation: vi.fn(),
    acceptOperation: vi.fn(),
    undoAcceptOperation: vi.fn(),
    confirmDiscardOperation: vi.fn(),
    cancelDiscardOperation: vi.fn(),
    discardOperation: vi.fn(),
    accept: vi.fn(async () => undefined),
    reject: vi.fn(),
    ...overrides,
  };
}

function group(row: DockRow) {
  return {
    documentId: row.documentId,
    documentName: row.documentName,
    contextPath: row.contextPath,
    drafts: [row.draft],
  };
}

function setContext(input: { rows: DockRow[]; controller: DraftReviewController }) {
  contextRef.current = {
    controller: input.controller,
    groups: input.rows.map(group),
    drafts: { status: "ready", groups: input.rows.map(group) },
    groupForDocument: () => null,
    reviewableDraftsForDocument: () => ({ visible: [], active: [] }),
    reviewableDraftsForGroup: () => ({ visible: [], active: [] }),
    nowMs: Date.parse("2026-07-04T00:01:00.000Z"),
    activeEditorDocumentId: null,
    setActiveEditorDocumentId: vi.fn(),
  } as unknown as DraftReviewContextValue;
}

async function renderDockHook(
  input: { rows: DockRow[]; controller: DraftReviewController },
  run: (api: {
    dock: () => DraftDockModel;
    rerender: (next: { rows: DockRow[]; controller: DraftReviewController }) => Promise<void>;
    flush: () => Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const rootNode = dom.window.document.getElementById("root");
  if (!rootNode) throw new Error("missing root");
  const root = createRoot(rootNode);
  const ref: { current: DraftDockModel | null } = { current: null };
  function Capture() {
    ref.current = useDraftDock({ generating: false });
    return null;
  }
  async function flush() {
    await act(async () => {
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  async function rerender(next: { rows: DockRow[]; controller: DraftReviewController }) {
    setContext(next);
    await act(async () => root.render(<Capture />));
    await flush();
  }
  try {
    await rerender(input);
    await run({
      dock: () => {
        if (!ref.current) throw new Error("dock not mounted");
        return ref.current;
      },
      rerender,
      flush,
    });
    await act(async () => root.unmount());
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
    contextRef.current = null;
  }
}

describe("DraftDock", () => {
  beforeEach(() => {
    contextRef.current = null;
    openAiDraftMock.mockClear();
  });

  it("renders nothing when unmounted", () => {
    const html = renderToStaticMarkup(<DraftDock dock={model({ mounted: false })} />);
    expect(html).toBe("");
  });

  it("generating changes exactly one thing: Apply/Discard are disabled", () => {
    const html = renderToStaticMarkup(
      <DraftDock
        dock={model({
          phase: "generating",
          generating: true,
          rows: [pendingRow("doc-1", "Chapter 12")],
        })}
      />,
    );
    // Same strip anatomy as settled — no spinner, no "Editing" label swap.
    expect(html).toContain("Chapter 12");
    expect(html).not.toContain("Editing");
    expect(html).not.toContain("animate-spin");
    // Review stays actionable; the bulk verbs render disabled.
    expect(html).toContain(">Review<");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Discard<\/button>/);
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
    expect(html).toContain("@max-[360px]:hidden");
  });

  it("terminal phase flashes All changes reviewed", () => {
    const html = renderToStaticMarkup(<DraftDock dock={model({ phase: "terminal", rows: [] })} />);
    expect(html).toContain("All changes reviewed");
  });

  it("cancels apply-all when the second draft settles without leaving pending", async () => {
    const rows = [
      pendingRow("doc-1", "A"),
      pendingRow("doc-2", "B"),
      pendingRow("doc-3", "C"),
      pendingRow("doc-4", "D"),
    ];
    const draftController = controller();

    await renderDockHook(
      { rows, controller: draftController },
      async ({ dock, rerender, flush }) => {
        await act(async () => dock().startApplyAll());
        await flush();
        expect(draftController.accept).toHaveBeenCalledTimes(1);
        expect(draftController.accept).toHaveBeenLastCalledWith("doc-1", "doc-1-d");

        await rerender({ rows, controller: { ...draftController, isPending: true } });
        await rerender({
          rows: [reviewedRow("doc-1", "A"), ...rows.slice(1)],
          controller: { ...draftController, isPending: false },
        });
        await flush();
        expect(draftController.accept).toHaveBeenCalledTimes(2);
        expect(draftController.accept).toHaveBeenLastCalledWith("doc-2", "doc-2-d");

        await rerender({
          rows: [reviewedRow("doc-1", "A"), ...rows.slice(1)],
          controller: { ...draftController, isPending: true },
        });
        await rerender({
          rows: [reviewedRow("doc-1", "A"), ...rows.slice(1)],
          controller: {
            ...draftController,
            isPending: false,
            cannotPlaceDraft: { documentId: "doc-2", draftId: "doc-2-d" },
          },
        });
        await flush();

        expect(draftController.accept).toHaveBeenCalledTimes(2);
        expect(dock().bulkActive).toBe(false);
        expect(dock().isBusy).toBe(false);
        expect(dock().pendingRows.map((row) => row.documentId)).toEqual([
          "doc-2",
          "doc-3",
          "doc-4",
        ]);
        expect(dock().isCannotPlaceRow(dock().pendingRows[0])).toBe(true);
      },
    );
  });

  it("cancels apply-all when accept rejects before the mutation starts", async () => {
    const rows = [pendingRow("doc-1", "A"), pendingRow("doc-2", "B")];
    const draftController = controller({
      accept: vi.fn(async () => {
        throw new Error("preview token request failed");
      }),
    });

    await renderDockHook({ rows, controller: draftController }, async ({ dock, flush }) => {
      await act(async () => dock().startApplyAll());
      await flush();

      expect(draftController.accept).toHaveBeenCalledTimes(1);
      expect(dock().bulkActive).toBe(false);
      expect(dock().isBusy).toBe(false);
      expect(dock().pendingRows.map((row) => row.documentId)).toEqual(["doc-1", "doc-2"]);
    });
  });
});
