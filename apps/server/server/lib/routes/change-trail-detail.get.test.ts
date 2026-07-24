/** Route contract coverage for retained detail whose authorized anchor was deleted. */
import { expect, it, vi } from "vitest";

const { readDetails } = vi.hoisted(() => ({
  readDetails: vi.fn(async () => [
    {
      trailId: "trail-1",
      documentId: "00000000-0000-4000-8000-000000000001",
      documentTitle: "Deleted chapter",
      anchorState: "deleted" as const,
      changes: [{ changeId: "change-1", writerProtection: { body: { markdown: "Captured." } } }],
    },
  ]),
}));

vi.mock("nitro/h3", () => ({
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: (_event: unknown, name: string) => (name === "threadId" ? "thread-1" : "trail-1"),
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

it("returns durable captured detail with explicit deleted-anchor state", async () => {
  await expect(handler({})).resolves.toEqual({
    version: 1,
    trailId: "trail-1",
    documents: [
      {
        trailId: "trail-1",
        documentId: "00000000-0000-4000-8000-000000000001",
        documentTitle: "Deleted chapter",
        anchorState: "deleted",
        changes: [{ changeId: "change-1", writerProtection: { body: { markdown: "Captured." } } }],
      },
    ],
  });
});
