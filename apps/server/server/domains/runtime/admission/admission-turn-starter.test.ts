/** Atomic side-effect ordering at the runner/admission transaction join. */
import { describe, expect, it, vi } from "vitest";
import { TurnStartConflictError } from "../../threads/index.js";
import { StaleConnectionTokenError } from "../loop/turn-runner.js";
import { createAdmissionTurnStarter } from "./admission-turn-starter.js";

const admission = {
  actorUserId: "11111111-1111-4111-8111-111111111111",
  threadId: "22222222-2222-4222-8222-222222222222",
  submissionId: "submission",
  text: "text",
  blocks: [],
  references: [],
} as never;
const admissionThreadId = "22222222-2222-4222-8222-222222222222" as never;
const admissionSubmissionId = "submission";

function startInput() {
  return {
    admission,
    fingerprint: "fingerprint",
    blocks: [{ type: "text" as const, text: "text" }],
    references: [
      {
        documentId: "33333333-3333-4333-8333-333333333333" as never,
        uri: "uploads://@/draft.png",
        purpose: "draft-upload" as const,
        intakeId: "intake",
        relationship: "created" as const,
      },
    ],
  };
}

describe("createAdmissionTurnStarter", () => {
  it("settles ledger, upload consumption, and provenance inside the runner callback", async () => {
    const order: string[] = [];
    const runner = {
      async startTurn(input: {
        admissionIdentity: { onAccepted(response: unknown): Promise<void> };
      }) {
        order.push("transaction-start");
        await input.admissionIdentity.onAccepted({
          kind: "accepted",
          threadId: admissionThreadId,
          submissionId: admissionSubmissionId,
          userTurnId: "user",
          assistantTurnId: "assistant",
          resumeAfterSeq: "1",
          snapshotFloorNextSeq: "5",
        });
        order.push("transaction-commit");
        return {
          userTurnId: "user",
          assistantTurnId: "assistant",
          resumeAfterSeq: "1",
          snapshotFloorNextSeq: "5",
        };
      },
    } as never;
    const starter = createAdmissionTurnStarter({
      runner,
      records: {
        lookup: vi.fn(),
        reserve: vi.fn(),
        reject: vi.fn(),
        retire: vi.fn(),
        recoverExpiredPending: vi.fn(),
        async accept() {
          order.push("ledger");
          return { kind: "accepted", response: {} as never };
        },
      },
      async consumeUploads() {
        order.push("consume");
      },
      async attachDocument() {
        order.push("provenance");
      },
    });
    await expect(starter.start(startInput())).resolves.toMatchObject({ kind: "accepted" });
    expect(order).toEqual([
      "transaction-start",
      "ledger",
      "consume",
      "provenance",
      "transaction-commit",
    ]);
  });

  it.each([
    [new StaleConnectionTokenError(), "connection_token_not_live"],
    [new TurnStartConflictError(admissionThreadId, "already_running"), "already_running"],
  ] as const)("persists %s without consuming an upload", async (failure, code) => {
    const consumeUploads = vi.fn();
    const reject = vi.fn(async (request: { code: string }) => ({
      state: "rejected" as const,
      fingerprint: "fingerprint",
      code: request.code,
    }));
    const starter = createAdmissionTurnStarter({
      runner: {
        async startTurn() {
          throw failure;
        },
      } as never,
      records: {
        lookup: vi.fn(),
        reserve: vi.fn(),
        retire: vi.fn(),
        accept: vi.fn(),
        reject,
        recoverExpiredPending: vi.fn(),
      },
      consumeUploads,
      attachDocument: vi.fn(),
    });
    await expect(starter.start(startInput())).resolves.toEqual({
      kind: "rejected",
      submissionId: "submission",
      code,
    });
    expect(reject).toHaveBeenCalledWith({
      threadId: admissionThreadId,
      submissionId: admissionSubmissionId,
      fingerprint: "fingerprint",
      code,
    });
    expect(consumeUploads).not.toHaveBeenCalled();
  });
});
