/** Route contract coverage for retained unavailable change-trail document slots. */
import { expect, it, vi } from "vitest";

const { readDetails } = vi.hoisted(() => ({
  readDetails: vi.fn(async () => [
    {
      trailId: "trail-1",
      documentId: "00000000-0000-4000-8000-000000000001",
      documentTitle: "Deleted chapter",
      unavailable: true as const,
      changes: [{ changeId: "change-1", writerProtection: { body: { markdown: "Captured." } } }],
    },
  ]),
}));

vi.mock("nitro/h3", () => ({
  defineEventHandler: (handler: unknown) => handler,
  getRouterParam: (_event: unknown, name: string) => (name === "threadId" ? "thread-1" : "trail-1"),
}));
vi.mock("../../../../../lib/auth-gate.js", () => ({
  requireAppUser: async () => ({
    user: { userId: "user-1" },
    app: {
      changeTrails: { readDetails },
      threadRepos: { threads: {} },
      projectRepo: {},
    },
  }),
}));
vi.mock("../../../../../domains/threads/index.js", () => ({ requireThreadOwner: vi.fn() }));

const handler = (await import("./[trailId].get.js")).default as (
  event: unknown,
) => Promise<unknown>;

it("returns durable captured detail with the unavailable marker after hard deletion", async () => {
  await expect(handler({})).resolves.toEqual({
    version: 1,
    trailId: "trail-1",
    documents: [
      {
        trailId: "trail-1",
        documentId: "00000000-0000-4000-8000-000000000001",
        documentTitle: "Deleted chapter",
        unavailable: true,
        changes: [{ changeId: "change-1", writerProtection: { body: { markdown: "Captured." } } }],
      },
    ],
  });
});
