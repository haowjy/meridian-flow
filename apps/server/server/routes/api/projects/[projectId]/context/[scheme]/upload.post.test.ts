/** Thin transport coverage for authoritative upload intake. */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextRoute } from "./_helpers.js";
import handler from "./upload.post.js";

vi.mock("./_helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_helpers.js")>()),
  resolveContextRoute: vi.fn(),
}));

const bytes = new Uint8Array([1, 2, 3]);
const digest = createHash("sha256").update(bytes).digest("hex");

function body() {
  const value = new FormData();
  value.set("file", new File([bytes], "cover.png", { type: "image/png" }));
  value.set("intakeId", "intake-1");
  value.set("byteDigest", digest);
  return value;
}

describe("POST context upload", () => {
  beforeEach(() => vi.mocked(resolveContextRoute).mockReset());

  it("maps fingerprint conflicts without route-owned retry policy", async () => {
    vi.mocked(resolveContextRoute).mockResolvedValue({
      app: {
        uploadIntake: {
          intake: vi.fn(async () => ({
            ok: false as const,
            error: { code: "idempotency_conflict" as const },
          })),
        },
      },
      userId: "user-1",
      projectId: "project-1",
      scheme: "uploads",
      workId: null,
    } as never);
    const event = {
      req: new Request("https://server.local/upload", { method: "POST", body: body() }),
      res: { status: 200 },
    };
    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 409 });
  });
});
