/** Root routes share validation and serialized definite-refusal identities. */
import { HTTPError } from "nitro/h3";
import { describe, expect, it } from "vitest";
import { AgentSelectionError } from "../domains/packages/index.js";
import interruptErrorHandler from "./interrupt-error-handler.js";
import {
  InvalidWorkAttachmentError,
  ThreadCreationConflictError,
  ThreadCreationNotFoundError,
} from "./thread-creation.js";
import { throwThreadCreationError } from "./thread-creation-http.js";

describe("root creation transport", () => {
  it.each([
    [new AgentSelectionError("revision"), "agent_not_found"],
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
  it("preserves infrastructure failures and maps identity conflicts to 409 or 404", () => {
    const failure = new Error("database unavailable");
    expect(() => throwThreadCreationError(failure)).toThrow(failure);
    try {
      throwThreadCreationError(new ThreadCreationConflictError());
    } catch (error) {
      expect(HTTPError.isError(error) && error.status).toBe(409);
    }
    try {
      throwThreadCreationError(new ThreadCreationNotFoundError());
    } catch (error) {
      expect(HTTPError.isError(error) && error.status).toBe(404);
    }
  });
});
