// @vitest-environment jsdom
/**
 * The import surfaces mounted over a real coordinator and store: the status row
 * the tree draws and the pane's document notice. The server is the fake import
 * server; the project context is a coordinator handed in through the provider seam.
 */
import { i18n } from "@lingui/core";
import type { ImportEntryReport, ImportReport } from "@meridian/contracts";
import { act, useSyncExternalStore } from "react";
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
vi.mock("./import-route", () => ({
  useImportRoute: () => ({ openReport: () => {}, closeReport: () => {} }),
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  useContextCatalogView: () => ({
    catalog: { findDocument: () => ({ importPending: context.importPending }) },
  }),
}));

import { ImportDocumentNotice } from "./ImportDocumentNotice";
import { ImportStatusRow } from "./ImportStatusRow";

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

/** The tree's way of drawing status rows: one per id in the coordinator's snapshot. */
function Tree({ coordinator }: { coordinator: ImportCoordinator }) {
  const snapshot = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot);
  return (
    <>
      {snapshot.ids.map((id) => (
        <ImportStatusRow key={id} importId={id} paddingLeft={16} />
      ))}
    </>
  );
}

describe("ImportStatusRow", () => {
  it("hides at once when a big finished import is dismissed, without breaking the tree", async () => {
    const server = fakeImportServer();
    const entries = Array.from({ length: 501 }, (_, id) => entry(id, "landed"));
    const finished = report({ state: "finished", entries });
    server.api.listOpen = async () => [finished];
    server.api.dismiss = () => new Promise(() => {});
    const coordinator = new ImportCoordinator("p", server.api);
    context.coordinator = coordinator;
    await coordinator.refreshOpen();
    coordinator.store("import-1").installReport(finished);
    const element = await mount(<Tree coordinator={coordinator} />);
    expect(element.textContent).toContain("Import");

    await act(async () => void coordinator.dismiss("import-1"));

    expect(element.textContent).toBe("");
  });
});

describe("ImportDocumentNotice", () => {
  const tab = { kind: "editable", documentId: "doc-0", scheme: "kb" } as never;

  it("keeps watching the import it found, and clears once the file lands elsewhere", async () => {
    const server = fakeImportServer();
    const arriving = report();
    server.api.listOpen = async () => [arriving];
    let reads = 0;
    server.api.changes = async () => {
      reads += 1;
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
    server.api.changes = async () => ({ ...quiet, entries: [] });
    const coordinator = new ImportCoordinator("p", server.api);
    context.coordinator = coordinator;
    await coordinator.refreshOpen();
    coordinator.store("import-1").installReport(quiet);

    const element = await mount(<ImportDocumentNotice projectId="p" tab={tab} />);

    expect(element.textContent).toContain("This file's import is paused.");
  });
});
