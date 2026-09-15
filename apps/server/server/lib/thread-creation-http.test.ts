/** Root routes share validation and serialized definite-refusal identities. */
import { HTTPError } from "nitro/h3";
import { describe, expect, it } from "vitest";
import interruptErrorHandler from "./interrupt-error-handler.js";
import {
  AgentBindingNotFoundError,
  InvalidWorkAttachmentError,
  ThreadCreationConflictError,
} from "./thread-creation.js";
import { parseCreationTitle, throwThreadCreationError } from "./thread-creation-http.js";

describe("root creation transport", () => {
  it.each([123, false, [], {}])("rejects malformed title %j", (value) => {
    expect(() => parseCreationTitle(value)).toThrow("title must be a string or null");
  });
  it("preserves title text and normalizes empty titles", () => {
    for (const value of [null, undefined, ""]) expect(parseCreationTitle(value)).toBeNull();
    expect(parseCreationTitle(" A scene ")).toBe(" A scene ");
  });
  it.each([
    [new AgentBindingNotFoundError("revision"), "agent_not_found"],
    [new InvalidWorkAttachmentError("Work unavailable"), "work_unavailable"],
  ])("serializes the shared refusal %s", async (error, code) => {
    let response: Response | undefined;
    try {
      throwThreadCreationError(error);
    } catch (mapped) {
      response = interruptErrorHandler(mapped, undefined);
    }
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ kind: "error", error: { code } });
  });
  it("preserves infrastructure failures and maps identity conflicts to 409", () => {
    const failure = new Error("database unavailable");
    expect(() => throwThreadCreationError(failure)).toThrow(failure);
    try {
      throwThreadCreationError(new ThreadCreationConflictError());
    } catch (error) {
      expect(HTTPError.isError(error) && error.status).toBe(409);
    }
  });
});
