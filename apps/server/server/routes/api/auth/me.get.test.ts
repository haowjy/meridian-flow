/** Contract regression for the authenticated canonical Meridian identity. */
import { expect, it, vi } from "vitest";

const { requireAppUserFromRequest } = vi.hoisted(() => ({
  requireAppUserFromRequest: vi.fn(async () => ({
    app: {},
    user: {
      userId: "cfeb7b0d-658d-4469-9d69-8aa381d8899f",
      externalId: "user_01workos",
      email: "writer@example.com",
      name: "Writer",
      avatarUrl: null,
    },
  })),
}));

vi.mock("nitro/h3", () => ({
  defineEventHandler: (handler: unknown) => handler,
}));
vi.mock("../../../lib/auth-gate.js", () => ({
  requireAppUserFromRequest,
}));

const handler = (await import("./me.get.js")).default as unknown as (event: {
  req: Request;
}) => Promise<unknown>;

it("returns the canonical internal user id from the authenticated app context", async () => {
  const req = new Request("https://api.meridian.localhost/api/auth/me");

  await expect(handler({ req })).resolves.toMatchObject({
    user: {
      userId: "cfeb7b0d-658d-4469-9d69-8aa381d8899f",
      externalId: "user_01workos",
    },
  });
  expect(requireAppUserFromRequest).toHaveBeenCalledWith(req);
});
