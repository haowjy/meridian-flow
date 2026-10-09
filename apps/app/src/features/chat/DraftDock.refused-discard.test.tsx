// @vitest-environment jsdom
/**
 * A refused Apply or Discard of this chat's changes shows on the file it was
 * sent for: under the strip for one document, on its row for several. The
 * changes come back with the reason; the other files still run. Real provider,
 * scopes, controllers and query cache; the network is the only fake.
 */
import { onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  click,
  draftItem,
  op,
  pacing,
  readPreview,
  renderStrip,
  resetServer,
  serverHolds,
  strip,
  stripShows,
  text,
} from "@/test-support/draft-dock-strip";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraftChanges: vi.fn(),
  discardDraft: vi.fn(),
  retainBranchRooms: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => mocks);
vi.mock("@/features/project/dock/useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft: vi.fn() }),
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({ catalog: null }),
  projectCatalogView: () => ({ findDocument: () => null }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ promoteAppliedDraft: vi.fn(), discardDraft: vi.fn() }),
  useOptionalAccountResourceReplica: () => null,
  useLiveDocumentSessionRegistry: () => ({
    retainBranchRooms: mocks.retainBranchRooms,
    releaseBranchRooms: vi.fn(),
    getBranchRoom: () => ({ document: { on: vi.fn(), off: vi.fn() } }),
  }),
}));

const render = (run: () => Promise<void>) => renderStrip(mocks.listWorkDrafts, run);
const rowOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-draft-dock-file]")].find((row) =>
    row.textContent?.includes(name),
  );

describe("DraftDock refused commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    resetServer();
    mocks.getDraftPreview.mockImplementation(readPreview);
  });
  afterEach(() => onlineManager.setOnline(true));

  it("shows a refused Discard under the strip for one document, with its changes back", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftItem("ch-12", "chapter-12", [pacing])],
    });
    serverHolds("ch-12", [op("1", "pacing"), op("2", "pacing")]);
    mocks.discardDraft.mockRejectedValue(new HttpResponseError("injected", 500, null));
    await render(async () => {
      await stripShows("2 changes");
      await click("Discard");
      await vi.waitFor(() =>
        expect(strip()?.querySelector("[data-draft-dock-strip-error]")?.textContent).toBe(
          "Couldn't discard this chat's changes. Try again.",
        ),
      );
      expect(text()).toContain("2 changes");
    });
  });

  it("opens the strip and shows the refusal on the refused document's row for several", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [
        draftItem("ch-12", "chapter-12", [pacing]),
        draftItem("ch-14", "chapter-14", [pacing]),
      ],
    });
    serverHolds("ch-12", [op("1", "pacing")]);
    serverHolds("ch-14", [op("7", "pacing")]);
    // Both are refused, each its own way: every file gets its turn, and each keeps its own reason.
    mocks.discardDraft.mockImplementation(async (_p: string, _w: string, documentId: string) => {
      if (documentId === "ch-12") throw new HttpResponseError("injected", 500, null);
      throw new TypeError("Failed to fetch");
    });
    await render(async () => {
      await stripShows("2 changes");
      await click("Discard");
      await click("Discard");
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-draft-dock-row-error]")).toHaveLength(2),
      );
      expect(mocks.discardDraft).toHaveBeenCalledTimes(2);
      expect(rowOf("chapter-12")?.querySelector("[data-draft-dock-row-error]")?.textContent).toBe(
        "Couldn't discard this chat's changes. Try again.",
      );
      expect(rowOf("chapter-14")?.querySelector("[data-draft-dock-row-error]")?.textContent).toBe(
        "Couldn't confirm whether these were discarded. Check what is left before you try again.",
      );
    });
  });

  it("brings the strip back with a refused Apply on its file, though every change had left at the click", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftItem("ch-12", "chapter-12", [pacing])],
    });
    serverHolds("ch-12", [op("1", "pacing")]);
    await render(async () => {
      await stripShows("1 change");
      onlineManager.setOnline(false);
      await click("Apply");
      await vi.waitFor(() =>
        expect(strip()?.querySelector("[data-draft-dock-strip-error]")?.textContent).toBe(
          "Couldn't apply. Check your connection and try again.",
        ),
      );
      expect(mocks.applyDraftChanges).not.toHaveBeenCalled();
    });
  });

  it("shows nothing when no command was refused", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [
        draftItem("ch-12", "chapter-12", [pacing]),
        draftItem("ch-14", "chapter-14", [pacing]),
      ],
    });
    serverHolds("ch-12", [op("1", "pacing")]);
    serverHolds("ch-14", [op("7", "pacing")]);
    await render(async () => {
      await stripShows("2 changes");
      expect(document.querySelector("[role=alert]")).toBeNull();
    });
  });
});
