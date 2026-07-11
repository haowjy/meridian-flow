/** Route contract coverage for retained unavailable change-trail document slots. */
import { expect, it, vi } from "vitest";

const { readDetails } = vi.hoisted(() => ({
  readDetails: vi.fn(async () => [
    { documentId: "00000000-0000-4000-8000-000000000001", unavailable: true as const },
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

it("returns the explicit unavailable marker retained after hard deletion", async () => {
  await expect(handler({})).resolves.toEqual({
    version: 1,
    trailId: "trail-1",
    documents: [{ documentId: "00000000-0000-4000-8000-000000000001", unavailable: true }],
  });
});
