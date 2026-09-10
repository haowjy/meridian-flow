/** Stable-ID-only availability HTTP body contract. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import handler, { parseAvailabilityBody } from "./availability.post.js";

vi.mock("../../../../../lib/auth-gate.js", () => ({ requireAppUser: vi.fn() }));

function id(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("availability route body", () => {
  beforeEach(() => vi.mocked(requireAppUser).mockReset());

  it("deduplicates and accepts 128 IDs", () => {
    const documentIds = Array.from({ length: 128 }, (_, index) => id(index));
    expect(
      parseAvailabilityBody(id(999), { documentIds: [...documentIds, documentIds[0]] }).documentIds,
    ).toEqual(documentIds);
  });

  it("rejects 129 IDs and non-ID lookup inputs", () => {
    expect(() =>
      parseAvailabilityBody(id(999), {
        documentIds: Array.from({ length: 129 }, (_, index) => id(index)),
      }),
    ).toThrow(/at most 128/);
    expect(() => parseAvailabilityBody(id(999), { paths: ["chapter.md"] })).toThrow(/documentIds/);
  });

  it.each([
    null,
    new Date("2026-01-01T00:00:00Z"),
  ])("allows the recorded owner to resolve a live or soft-deleted project", async (deletedAt) => {
    const projectId = id(999);
    const userId = id(998);
    const lookup = vi.fn(async () => ({ projectId, resolutionId: "resolution", resolutions: [] }));
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId },
      app: {
        projectRepo: { findById: vi.fn(async () => ({ id: projectId, userId, deletedAt })) },
        projectContextAvailability: { lookup },
      },
    } as never);
    const event = {
      req: new Request(`https://server.local/api/projects/${projectId}/context/availability`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentIds: [] }),
      }),
      context: { params: { projectId } },
      res: { status: 200 },
    };

    await expect(handler(event as never)).resolves.toMatchObject({ projectId });
    expect(lookup).toHaveBeenCalledWith({ projectId, documentIds: [] }, { userId });
  });

  it("conceals a foreign owner without invoking identity lookup", async () => {
    const projectId = id(999);
    const lookup = vi.fn();
    vi.mocked(requireAppUser).mockResolvedValue({
      user: { userId: id(998) },
      app: {
        projectRepo: {
          findById: vi.fn(async () => ({ id: projectId, userId: id(997), deletedAt: null })),
        },
        projectContextAvailability: { lookup },
      },
    } as never);
    const event = {
      req: new Request(`https://server.local/api/projects/${projectId}/context/availability`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentIds: [] }),
      }),
      context: { params: { projectId } },
      res: { status: 200 },
    };

    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 404 });
    expect(lookup).not.toHaveBeenCalled();
  });
});
