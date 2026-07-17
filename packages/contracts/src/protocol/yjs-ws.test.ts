import { describe, expect, it } from "vitest";
import { YJS_WS_CLOSE } from "./yjs-ws.js";

describe("Yjs WebSocket close contracts", () => {
  it("registers schema refusals beside existing typed closes", () => {
    expect(YJS_WS_CLOSE).toMatchObject({
      AUTH_FAILED: { code: 4401, reason: "auth_failed" },
      PERMISSION_DENIED: { code: 4403, reason: "permission-denied" },
      BRANCH_STALE: { code: 4205, reason: "branch-stale-doc" },
      CLIENT_SCHEMA_SUPERSEDED: { code: 4406, reason: "client-schema-superseded" },
      DOCUMENT_SCHEMA_STALE: { code: 4407, reason: "document-schema-stale" },
    });
  });
});
