/** Shared human/model Work metadata HTTP boundary. */
import type { Project } from "@meridian/contracts/projects";
import type { Work } from "@meridian/contracts/works";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import handler from "./index.patch.js";

vi.mock("../../../../lib/auth-gate.js", () => ({ requireAppUser: vi.fn() }));

const USER_ID = "00000000-0000-4000-8000-000000000901";
const PROJECT_ID = "00000000-0000-4000-8000-000000000902";
const WORK_ID = "00000000-0000-4000-8000-000000000903";

function event(body: unknown) {
  return {
    req: new Request(`https://server.local/api/works/${WORK_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    context: { params: { workId: WORK_ID } },
    res: { status: 200 },
  };
}

function fixture() {
  let work = {
    id: WORK_ID,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    name: "Draft",
    goal: null,
    description: null,
    status: "active",
    deletedAt: null,
  } as Work;
  const project = { id: PROJECT_ID, userId: USER_ID, deletedAt: null } as Project;
  const update = vi.fn(async (_id: string, input: Partial<Work>) => {
    work = { ...work, ...input };
    return work;
  });
  const projectChanged = vi.fn(async () => {});
  return {
    update,
    projectChanged,
    app: {
      projectRepo: { findById: async () => project },
      workRepo: {
        findById: async () => work,
        lockById: async () => work,
        update,
        transaction: async (operation: () => Promise<unknown>) => operation(),
      },
      workContextDelivery: { projectChanged },
    },
  };
}

describe("PATCH /api/works/:workId", () => {
  beforeEach(() => vi.mocked(requireAppUser).mockReset());

  it("authorizes, normalizes, and returns the shared metadata mutation result", async () => {
    const f = fixture();
    vi.mocked(requireAppUser).mockResolvedValue({ user: { userId: USER_ID }, app: f.app } as never);

    await expect(
      handler(event({ name: "  Revised  ", goal: "Finish act one" }) as never),
    ).resolves.toMatchObject({
      value: { id: WORK_ID, name: "Revised", goal: "Finish act one" },
    });
    expect(f.update).toHaveBeenCalledWith(WORK_ID, {
      name: "Revised",
      goal: "Finish act one",
      description: null,
      status: "active",
    });
    expect(f.projectChanged).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("rejects invalid metadata before persistence", async () => {
    const f = fixture();
    vi.mocked(requireAppUser).mockResolvedValue({ user: { userId: USER_ID }, app: f.app } as never);

    await expect(handler(event({ name: "   " }) as never)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(f.update).not.toHaveBeenCalled();
  });

  it("clears and trims optional metadata through the shared domain normalizer", async () => {
    const f = fixture();
    vi.mocked(requireAppUser).mockResolvedValue({ user: { userId: USER_ID }, app: f.app } as never);

    await expect(
      handler(event({ goal: "   ", description: "  Private notes  " }) as never),
    ).resolves.toMatchObject({ value: { goal: null, description: "Private notes" } });
    expect(f.update).toHaveBeenCalledWith(WORK_ID, {
      name: "Draft",
      goal: null,
      description: "Private notes",
      status: "active",
    });
  });

  it("rejects lifecycle status on the metadata route", async () => {
    const f = fixture();
    vi.mocked(requireAppUser).mockResolvedValue({ user: { userId: USER_ID }, app: f.app } as never);

    await expect(handler(event({ status: "archived" }) as never)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(f.update).not.toHaveBeenCalled();
  });
});
