/** A retired admission must refuse a late POST, never acknowledge an undefined turn. */
import { H3 } from "nitro/h3";
import { expect, it, vi } from "vitest";
import handler from "./messages.post.js";

vi.mock("../../../../lib/auth-gate.js", () => ({
  requireAppUser: async () => ({
    user: { userId: "11111111-1111-4111-8111-111111111111" },
    app: {
      threadRuntime: { requireOwnedThread: async () => undefined },
      userTurnAdmission: {
        admit: async () => ({ kind: "retired", submissionId: "submission", code: "retired" }),
      },
    },
  }),
}));

it("answers 409 retired for a retired submission", async () => {
  const app = new H3().post("/api/threads/:threadId/messages", handler);
  const response = await app.request(
    "http://localhost/api/threads/22222222-2222-4222-8222-222222222222/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionId: "submission", text: "Keep these words" }),
    },
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ message: "retired" });
});
