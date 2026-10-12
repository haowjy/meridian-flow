/** `retry_pending` asks the client to repeat the same request id, and says when. */
import { H3 } from "nitro/h3";
import { expect, it, vi } from "vitest";
import { ReplyRetryPendingError } from "../../../../../../domains/runtime/index.js";
import handler from "./retry.post.js";

vi.mock("../../../../../../lib/auth-gate.js", () => ({
  requireAppUser: async () => ({
    user: { userId: "11111111-1111-4111-8111-111111111111" },
    app: {
      threadRuntime: { requireOwnedThread: async () => undefined },
      runner: {
        retryReply: async ({ threadId }: { threadId: string }) => {
          throw new ReplyRetryPendingError(threadId as never);
        },
      },
    },
  }),
}));

it("answers retry_pending as 503 with Retry-After", async () => {
  const app = new H3().post("/api/threads/:threadId/turns/:turnId/retry", handler);
  const response = await app.request(
    "http://localhost/api/threads/22222222-2222-4222-8222-222222222222/turns/33333333-3333-4333-8333-333333333333/retry",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "44444444-4444-4444-8444-444444444444" }),
    },
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(await response.json()).toMatchObject({ message: "retry_pending" });
});
