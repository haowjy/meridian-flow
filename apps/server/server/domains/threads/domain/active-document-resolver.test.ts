/** Behavior coverage for the canonical thread active-document definition. */
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "../adapters/in-memory/repositories.js";
import { createActiveDocumentResolver } from "./active-document-resolver.js";

const USER_ID = "00000000-0000-4000-8000-000000000401" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-000000000402" as ProjectId;
const THREAD_ID = "00000000-0000-4000-8000-000000000403" as ThreadId;
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000404" as ThreadId;
const TURN_ID = "00000000-0000-4000-8000-000000000405" as TurnId;
const OTHER_TURN_ID = "00000000-0000-4000-8000-000000000406" as TurnId;

describe("active document resolver", () => {
  it("unifies explicit attachments and tool touches in both directions", async () => {
    const repositories = createInMemoryRepositories();
    await repositories.threads.create({
      id: THREAD_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
    });
    await repositories.threads.create({
      id: OTHER_THREAD_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
    });
    await repositories.turns.create({ id: TURN_ID, threadId: THREAD_ID, role: "assistant" });
    await repositories.turns.create({
      id: OTHER_TURN_ID,
      threadId: OTHER_THREAD_ID,
      role: "assistant",
    });
    await repositories.threadDocuments.attach(THREAD_ID, "attached", "editing");
    await repositories.threadDocuments.attach(THREAD_ID, "shared", "editing");
    await repositories.documentTouches.recordTouch(TURN_ID, "touched");
    await repositories.documentTouches.recordTouch(TURN_ID, "shared");
    await repositories.documentTouches.recordTouch(OTHER_TURN_ID, "touched");

    const resolver = createActiveDocumentResolver(repositories);

    await expect(resolver.listDocumentIds(THREAD_ID)).resolves.toEqual([
      "attached",
      "shared",
      "touched",
    ]);
    await expect(resolver.listThreadIds("touched")).resolves.toEqual([THREAD_ID, OTHER_THREAD_ID]);
  });
});
