/** HTTP boundary coverage for catalog scope and replay query validation. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import changesHandler from "./changes.get.js";
import snapshotHandler from "./snapshot.get.js";

vi.mock("../../../../../../lib/auth-gate.js", () => ({ requireAppUser: vi.fn() }));

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

function event(path: string) {
  return {
    req: new Request(`https://server.local${path}`),
    context: { params: { projectId: PROJECT_ID } },
    res: { status: 200 },
  };
}

function arrange() {
  const byId = vi.fn();
  const snapshot = vi.fn();
  const changes = vi.fn();
  vi.mocked(requireAppUser).mockResolvedValue({
    user: { userId: "00000000-0000-4000-8000-000000000002" },
    app: {
      projectRepo: {
        findById: vi.fn(async () => ({ userId: "00000000-0000-4000-8000-000000000002" })),
      },
      workAuthorityResolver: { byId },
      contextCatalog: { snapshot, changes },
    },
  } as never);
  return { byId, snapshot, changes };
}

describe("catalog route queries", () => {
  beforeEach(() => vi.mocked(requireAppUser).mockReset());

  it("rejects a malformed Work UUID before authority resolution", async () => {
    const { byId, snapshot } = arrange();

    await expect(
      snapshotHandler(
        event(
          `/api/projects/${PROJECT_ID}/context/catalog/snapshot?scope=work&workId=not-a-uuid`,
        ) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(byId).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("preserves not-found semantics for a valid absent Work", async () => {
    const { byId, snapshot } = arrange();
    byId.mockResolvedValue(null);

    await expect(
      snapshotHandler(
        event(
          `/api/projects/${PROJECT_ID}/context/catalog/snapshot?scope=work&workId=${PROJECT_ID.toUpperCase()}`,
        ) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(byId).toHaveBeenCalledWith(PROJECT_ID, PROJECT_ID);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it.each([
    "not-a-number",
    "-1",
    "1.5",
    "9007199254740992",
  ])("rejects invalid replay limit %s before catalog access", async (limit) => {
    const { changes } = arrange();

    await expect(
      changesHandler(
        event(
          `/api/projects/${PROJECT_ID}/context/catalog/changes?cursor=cursor&limit=${limit}`,
        ) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(changes).not.toHaveBeenCalled();
  });

  it("accepts a positive safe replay limit for the domain clamp", async () => {
    const { changes } = arrange();

    await changesHandler(
      event(
        `/api/projects/${PROJECT_ID}/context/catalog/changes?cursor=cursor&limit=999999`,
      ) as never,
    );

    expect(changes).toHaveBeenCalledWith(
      { kind: "project", projectId: PROJECT_ID },
      "cursor",
      999999,
    );
  });
});
