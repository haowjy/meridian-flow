/** Runtime contract proofs for draft HTTP acknowledgements. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { postJsonMock } = vi.hoisted(() => ({ postJsonMock: vi.fn() }));

vi.mock("./http-client", () => ({
  getJson: vi.fn(),
  postJson: postJsonMock,
}));

const { applyDraft } = await import("./drafts-api");
const request = { draftId: "draft-1" } as const;

describe("applyDraft", () => {
  beforeEach(() => postJsonMock.mockReset());

  it.each([
    ["non-object JSON", null],
    ["empty object", {}],
    ["missing draft ID", { status: "applied" }],
    ["non-applied discriminator", { status: "not-applied", draftId: "draft-1" }],
    ["wrong draft ID", { status: "applied", draftId: "draft-2" }],
  ])("rejects %s as an outcome-unknown Apply acknowledgement", async (_name, response) => {
    postJsonMock.mockResolvedValue(response);
    await expect(applyDraft("project-1", "work-1", "doc-1", request)).rejects.toThrow(
      "did not prove",
    );
    expect(postJsonMock).toHaveBeenCalledOnce();
  });

  it("accepts the exact authoritative Apply acknowledgement", async () => {
    const response = { status: "applied", draftId: "draft-1" };
    postJsonMock.mockResolvedValue(response);
    await expect(applyDraft("project-1", "work-1", "doc-1", request)).resolves.toEqual(response);
    expect(postJsonMock).toHaveBeenCalledOnce();
  });
});
