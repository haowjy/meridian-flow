import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveWork,
  deleteWork,
  listWorkThreads,
  unarchiveWork,
  updateWork,
} from "./projects-api";

afterEach(() => vi.unstubAllGlobals());

describe("Work lifecycle requests", () => {
  it("targets the server-owned Work routes for every lifecycle action", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json(workResponse()),
    );
    vi.stubGlobal("fetch", fetchMock);

    await updateWork("work-1", { name: "Revision" });
    await archiveWork("work-1");
    await unarchiveWork("work-1");
    await deleteWork("work-1");

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/works/work-1", "PATCH"],
      ["/api/works/work-1/archive", "POST"],
      ["/api/works/work-1/unarchive", "POST"],
      ["/api/works/work-1", "DELETE"],
    ]);
  });

  it("preserves the API error message and status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ message: "Work still has conversations" }, { status: 409 }),
      ),
    );

    await expect(deleteWork("work-1")).rejects.toMatchObject({
      name: "HttpResponseError",
      message: "Work still has conversations",
      status: 409,
    });
  });

  it("sends optional metadata clears as accepted empty strings", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(workResponse()),
    );
    vi.stubGlobal("fetch", fetchMock);
    await updateWork("work-1", { goal: "", description: "" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      goal: "",
      description: "",
    });
  });
});

describe("Work-associated chat requests", () => {
  it("requests the canonical endpoint and unwraps its typed collection", async () => {
    const page = { items: [{ id: "thread-1", title: "Opening" }], nextCursor: "next" };
    const fetchMock = vi.fn(async () => Response.json(page));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listWorkThreads("work-1", {
        origin: "https://app.example",
        headers: { "x-request": "typed" },
      }),
    ).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.example/api/works/work-1/threads",
      expect.objectContaining({ headers: { "x-request": "typed" } }),
    );
  });
});

function workResponse() {
  return {
    id: "work-1",
    projectId: "project-1",
    createdByUserId: "user-1",
    name: "Revision",
    goal: null,
    description: null,
    status: "active",
    archivedAt: null,
    aiWriteMode: "draft",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    lastActivityAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
  };
}
