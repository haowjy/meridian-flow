/**
 * Opening a document the writer just created, before the server has it: the
 * local record opens where its placement says, including No Work's Scratch,
 * whose placement carries a null Work id until the server answers.
 */
import { planResourceLocation, reserveResourceDocument } from "@meridian/resource-replica";
import { describe, expect, it, vi } from "vitest";

import { ProjectDocumentNavigationAdapter } from "./open-project-document";

const PROJECT = "01900000-0000-7000-8000-000000000002";
const DOCUMENT = "01900000-0000-7000-8000-000000000101";
const NO_WORK = "01900000-0000-7000-8000-000000000900";

function placed(destination: { scheme: "scratch" | "kb"; workId: string | null }) {
  const reserved = reserveResourceDocument({
    projectId: PROJECT,
    handle: "handle-1",
    documentId: DOCUMENT,
    databaseName: "db",
    schema: "schema",
    intentId: "intent-1",
  }).next;
  const write = planResourceLocation({
    record: reserved,
    projectId: PROJECT,
    intentId: "intent-2",
    eligibleAt: 1,
    destination: { ...destination, folderPath: "side", name: "no-work.md" },
  });
  if (!write) throw new Error("placement refused");
  return write.next;
}

function adapter(record: ReturnType<typeof placed>, noWorkId: string | null) {
  const openRoute = vi.fn(async () => ({ kind: "applied" as const }));
  const navigation = new ProjectDocumentNavigationAdapter({
    opener: {
      open: vi.fn(async () => ({ kind: "unavailable" as const, reason: "failed" as const })),
    },
    openTab: vi.fn(),
    openRoute,
    noWorkId: () => noWorkId,
    resources: {
      accountId: "account",
      openKnownDocument: vi.fn(async () => ({
        kind: "opened" as const,
        key: { handle: "handle-1" },
        record,
        handle: { release: vi.fn() },
      })) as never,
      openDocument: vi.fn() as never,
    },
  });
  return { navigation, openRoute };
}

describe("opening a just-created document", () => {
  it("opens a No Work Scratch placement in No Work's scope", async () => {
    const { navigation, openRoute } = adapter(placed({ scheme: "scratch", workId: null }), NO_WORK);
    const result = await navigation.open(PROJECT, { documentId: DOCUMENT });

    expect(result.kind).toBe("opened");
    expect(openRoute).toHaveBeenCalledWith(
      { scheme: "scratch", path: "/side/no-work.md", workId: NO_WORK, documentId: DOCUMENT },
      expect.anything(),
    );
  });

  it("opens a project placement as before", async () => {
    const { navigation, openRoute } = adapter(placed({ scheme: "kb", workId: null }), NO_WORK);
    expect((await navigation.open(PROJECT, { documentId: DOCUMENT })).kind).toBe("opened");
    expect(openRoute).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: "kb", path: "/side/no-work.md" }),
      expect.anything(),
    );
  });

  it("cannot place a No Work Scratch document before the No Work row is known", async () => {
    const { navigation, openRoute } = adapter(placed({ scheme: "scratch", workId: null }), null);
    expect((await navigation.open(PROJECT, { documentId: DOCUMENT })).kind).toBe("unavailable");
    expect(openRoute).not.toHaveBeenCalled();
  });
});
