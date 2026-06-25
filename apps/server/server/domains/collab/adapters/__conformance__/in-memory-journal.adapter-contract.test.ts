import { describe, it } from "vitest";
import { createInMemoryJournal } from "../in-memory/agent-edit.js";
import { expectReversalMutationStatusContract } from "./journal-reversal-mutation-status-contract.js";

const DOC_ID = "doc-1";
const THREAD_ID = "thread-1";
const USER_ID = "user-1";
const TURN_A = "turn-a";
const TURN_B = "turn-b";

describe("in-memory journal adapter contract", () => {
  it("matches reversal mutation status transitions", async () => {
    await expectReversalMutationStatusContract({
      journal: createInMemoryJournal(),
      docId: DOC_ID,
      threadId: THREAD_ID,
      turnIds: [TURN_A, TURN_B],
      userId: USER_ID,
    });
  });
});
