/** Route contract coverage for retained unavailable change-trail document slots. */
import { expect, it, vi } from "vitest";

const { readDetails, THREAD_ID, TRAIL_ID } = vi.hoisted(() => {
  const THREAD_ID = "00000000-0000-0000-0000-000000000010";
  const TRAIL_ID = "00000000-0000-0000-0000-000000000011";
  return {
    THREAD_ID,
    TRAIL_ID,
    readDetails: vi.fn(async () => [
      {
        trailId: TRAIL_ID,
        documentId: "00000000-0000-4000-8000-000000000001",
        documentTitle: "Deleted chapter",
        unavailable: true as const,
        changes: [{ changeId: "change-1", writerProtection: { body: { markdown: "Captured." } } }],
      },
    ]),
  };
});

vi.mock("nitro/h3", () => ({
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: (_event: unknown, name: string) => (name === "threadId" ? THREAD_ID : TRAIL_ID),
}));
vi.mock("../auth-gate.js", () => ({
  requireAppUser: async () => ({
    user: { userId: "user-1" },
    app: {
      changeTrails: { readDetails },
      threadRepos: { threads: {} },
      projectRepo: {},
    },
  }),
}));
vi.mock("../../domains/threads/index.js", () => ({ requireThreadOwner: vi.fn() }));

const handler = (await import("../../routes/api/threads/[threadId]/change-trails/[trailId].get.js"))
  .default as (event: unknown) => Promise<unknown>;

it("returns durable captured detail with the unavailable marker after hard deletion", async () => {
  await expect(handler({})).resolves.toEqual({
    version: 1,
    trailId: TRAIL_ID,
    documents: [
      {
        trailId: TRAIL_ID,
        documentId: "00000000-0000-4000-8000-000000000001",
        documentTitle: "Deleted chapter",
        unavailable: true,
        changes: [{ changeId: "change-1", writerProtection: { body: { markdown: "Captured." } } }],
      },
    ],
  });
});
