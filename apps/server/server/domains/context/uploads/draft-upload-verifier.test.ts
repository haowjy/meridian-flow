/** A chat cannot attach another chat's pending upload by id. */
import { expect, it } from "vitest";
import { createDraftUploadVerifier } from "./draft-upload-verifier.js";

it("admits only the sending thread's top chat as the upload's owner", async () => {
  const verify = createDraftUploadVerifier({
    identities: {
      lookupUpload: async () => ({ intakeId: "intake", ownerChatId: "chat-a" }) as never,
    },
    chats: {
      resolveTopPrimaryChat: async (threadId) =>
        ({ chatId: threadId === "subagent-of-a" ? "chat-a" : threadId, chatRef: "c1" }) as never,
    },
  });
  const reference = { documentId: "document", intakeId: "intake" };
  expect(await verify(reference, "chat-a")).toBe(true);
  expect(await verify(reference, "subagent-of-a")).toBe(true);
  expect(await verify(reference, "chat-b")).toBe(false);
  expect(await verify({ ...reference, intakeId: "other" }, "chat-a")).toBe(false);
});
