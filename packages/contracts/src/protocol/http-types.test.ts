/** Working-set route parsing protects the scheme/work authority wire invariant. */
import { describe, expect, it } from "vitest";
import {
  forkThreadRequestSchema,
  handoffBriefRetryRequestSchema,
  parseWorkingSetRoute,
  parseWorkingSetRouteList,
  replyRetryRequestSchema,
} from "./http-types.js";
import { apiThreadHandoffBriefPath, apiThreadTurnRetryPath } from "./paths.js";

describe("fork request schema", () => {
  it("requires a client id and explicit cutoff and rejects removed Agent selection input", () => {
    const request = { id: crypto.randomUUID(), originTurnId: crypto.randomUUID() };
    expect(forkThreadRequestSchema.safeParse(request).success).toBe(true);
    expect(forkThreadRequestSchema.safeParse({ id: request.id }).success).toBe(false);
    expect(
      forkThreadRequestSchema.safeParse({
        ...request,
        agentSelection: {
          catalogEntryId: crypto.randomUUID(),
          definitionRevisionId: crypto.randomUUID(),
        },
      }).success,
    ).toBe(false);
  });
});

describe("reply retry request schema", () => {
  it("requires exactly one client-minted UUID", () => {
    expect(replyRetryRequestSchema.safeParse({ id: crypto.randomUUID() }).success).toBe(true);
    expect(replyRetryRequestSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
    expect(
      replyRetryRequestSchema.safeParse({ id: crypto.randomUUID(), turnId: crypto.randomUUID() })
        .success,
    ).toBe(false);
  });

  it("builds the canonical retry path for a failed reply", () => {
    expect(apiThreadTurnRetryPath("thread-id", "turn-id")).toBe(
      "/api/threads/thread-id/turns/turn-id/retry",
    );
  });
});

describe("handoff brief retry route contract", () => {
  it("requires one client-minted seed id and rejects extra fields", () => {
    expect(handoffBriefRetryRequestSchema.safeParse({ id: crypto.randomUUID() }).success).toBe(
      true,
    );
    expect(
      handoffBriefRetryRequestSchema.safeParse({ id: crypto.randomUUID(), control: {} }).success,
    ).toBe(false);
    expect(handoffBriefRetryRequestSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
  });

  it("builds the canonical direct retry path", () => {
    expect(apiThreadHandoffBriefPath("thread-id")).toBe("/api/threads/thread-id/handoff/brief");
  });
});

describe("working-set route parser", () => {
  it("accepts each valid union arm", () => {
    const documentId = "00000000-0000-0000-0000-000000000001";
    expect(parseWorkingSetRoute({ documentId, scheme: "manuscript", path: "/chapter.md" })).toEqual(
      {
        ok: true,
        value: { documentId, scheme: "manuscript", path: "/chapter.md" },
      },
    );
    expect(
      parseWorkingSetRoute({ documentId, scheme: "scratch", path: "/notes.md", workId: null }),
    ).toEqual({
      ok: true,
      value: { documentId, scheme: "scratch", path: "/notes.md", workId: null },
    });
  });

  it("names a chat's Scratch by its lineage and refuses any other owner pairing", () => {
    const documentId = "00000000-0000-0000-0000-000000000001";
    const rootThreadId = "00000000-0000-0000-0000-000000000002";
    expect(
      parseWorkingSetRoute({ documentId, scheme: "scratch", path: "/notes.md", rootThreadId }),
    ).toEqual({
      ok: true,
      value: { documentId, scheme: "scratch", path: "/notes.md", rootThreadId },
    });
    for (const route of [
      { documentId, scheme: "scratch", path: "/notes.md", rootThreadId, workId: null },
      { documentId, scheme: "uploads", path: "/cover.png", rootThreadId },
      { documentId, scheme: "manuscript", path: "/chapter.md", rootThreadId },
      { documentId, scheme: "scratch", path: "/notes.md", rootThreadId: "chat" },
    ])
      expect(parseWorkingSetRoute(route).ok).toBe(false);
  });

  it("rejects locator-only and malformed document identities", () => {
    expect(parseWorkingSetRoute({ scheme: "manuscript", path: "/chapter.md" }).ok).toBe(false);
    expect(
      parseWorkingSetRoute({ documentId: "not-a-uuid", scheme: "manuscript", path: "/chapter.md" })
        .ok,
    ).toBe(false);
  });

  it("enforces workId pairing in both directions", () => {
    const documentId = "00000000-0000-0000-0000-000000000001";
    expect(parseWorkingSetRoute({ documentId, scheme: "scratch", path: "/notes.md" }).ok).toBe(
      false,
    );
    expect(
      parseWorkingSetRoute({ documentId, scheme: "manuscript", path: "/chapter.md", workId: null })
        .ok,
    ).toBe(false);
  });

  it("rejects invalid paths and invalid list entries at their intended guards", () => {
    const validRoute = {
      documentId: "00000000-0000-0000-0000-000000000001",
      scheme: "manuscript" as const,
      path: "/chapter.md",
    };

    expect(parseWorkingSetRoute({ ...validRoute, path: "" })).toEqual({
      ok: false,
      message: "Working-set route path must contain 1 to 1024 characters",
    });
    expect(parseWorkingSetRoute({ ...validRoute, path: "x".repeat(1025) })).toEqual({
      ok: false,
      message: "Working-set route path must contain 1 to 1024 characters",
    });
    expect(parseWorkingSetRoute({ ...validRoute, path: "x".repeat(1024) }).ok).toBe(true);
    expect(parseWorkingSetRoute({ ...validRoute, scheme: "unknown" })).toEqual({
      ok: false,
      message: "Working-set route has an unknown scheme",
    });
    expect(parseWorkingSetRouteList([{ ...validRoute, scheme: "unknown" }])).toEqual({
      ok: false,
      message: "Working-set route has an unknown scheme",
    });
  });
});
