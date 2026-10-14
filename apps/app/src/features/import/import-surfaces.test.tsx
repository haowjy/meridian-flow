// @vitest-environment jsdom
/**
 * The pane's document notice mounted over a real coordinator and store. The server is the fake import
 * server; the project context is a coordinator handed in through the provider seam.
 */
import { i18n } from "@lingui/core";
import type { ImportEntryReport, ImportReport } from "@meridian/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeImportServer } from "./fake-import-server";
import { ImportCoordinator } from "./import-coordinator";

const context = vi.hoisted(() => ({
  coordinator: null as unknown as ImportCoordinator,
  importPending: true,
}));

vi.mock("./ImportProvider", async (actual) => ({
  ...(await actual<typeof import("./ImportProvider")>()),
  useImports: () => ({ coordinator: context.coordinator, openContinue: () => {} }),
  useOptionalImports: () => ({ coordinator: context.coordinator, openContinue: () => {} }),
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  useContextCatalogView: () => ({
    catalog: { findDocument: () => ({ importPending: context.importPending }) },
  }),
}));

import { ImportDocumentNotice } from "./ImportDocumentNotice";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18n.loadAndActivate({ locale: "en", messages: {} });
});

let mounted: { root: Root; element: HTMLElement } | null = null;
afterEach(async () => {
  vi.useRealTimers();
  if (mounted) await act(async () => mounted?.root.unmount());
  mounted?.element.remove();
  mounted = null;
  context.coordinator?.dispose();
  context.importPending = true;
});

async function mount(node: React.ReactNode) {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  mounted = { root, element };
  await act(async () => root.render(node));
  return element;
}

function entry(entryId: number, state: ImportEntryReport["state"]): ImportEntryReport {
  return {
    entryId,
    rootId: 0,
    path: `Note ${entryId}.md`,
    filename: `Note ${entryId}.md`,
    size: 2,
    sha256: "a".repeat(64),
    documentId: `doc-${entryId}`,
    kind: "note",
    state,
    uri: `kb://Note ${entryId}`,
    name: `Note ${entryId}`,
    reason: null,
    exists: true,
    wanted: false,
    findings: [],
  };
}

function report(overrides: Partial<ImportReport> = {}): ImportReport {
  const entries = overrides.entries ?? [entry(0, "planned")];
  const landed = entries.filter((e) => e.state === "landed").length;
  return {
    importId: "import-1",
    state: "ready",
    destination: { folderUri: "kb://", folderId: null },
    sort: false,
    counts: {
      total: entries.length,
      landed,
      failed: 0,
      arriving: entries.length - landed,
      deleted: 0,
      notImported: 0,
      skipped: 0,
      findings: 0,
    },
    lastActivityAt: new Date().toISOString(),
    version: "1",
    dismissedAt: null,
    roots: [{ rootId: 0, kind: "folder", name: "Book", id: "root", uri: "kb://Book/" }],
    entries,
    ...overrides,
  };
}

describe("ImportDocumentNotice", () => {
  const tab = { kind: "editable", documentId: "doc-0", scheme: "kb" } as never;

  it("keeps watching the import it found, and clears once the file lands elsewhere", async () => {
    const server = fakeImportServer();
    const arriving = report();
    server.api.listOpen = async () => [arriving];
    let reads = 0;
    server.api.changes = async () => {
      reads += 1;
      // The landing clears the catalog's pending flag too.
      context.importPending = false;
      return {
        ...report({ entries: [entry(0, "landed")], version: "2", state: "finished" }),
      };
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const coordinator = new ImportCoordinator("p", server.api);
    context.coordinator = coordinator;
    await coordinator.refreshOpen();
    coordinator.store("import-1").installReport(arriving);
    const element = await mount(<ImportDocumentNotice projectId="p" tab={tab} />);
    expect(element.textContent).toContain("This file is still importing.");

    // The notice's next poll is due: run it, and the render it causes.
    await act(() => vi.runOnlyPendingTimersAsync());

    expect(reads).toBeGreaterThan(0);
    expect(element.textContent).toBe("");
  });

  it("says the import is paused when nothing has been heard from it for a while", async () => {
    const server = fakeImportServer();
    const quiet = report({ lastActivityAt: "2000-01-01T00:00:00.000Z" });
    server.api.listOpen = async () => [quiet];
    server.api.changes = async () => ({ ...quiet, roots: [], entries: [] });
    const coordinator = new ImportCoordinator("p", server.api);
    context.coordinator = coordinator;
    await coordinator.refreshOpen();
    coordinator.store("import-1").installReport(quiet);

    const element = await mount(<ImportDocumentNotice projectId="p" tab={tab} />);

    expect(element.textContent).toContain("This file's import stopped partway.");
  });
});
