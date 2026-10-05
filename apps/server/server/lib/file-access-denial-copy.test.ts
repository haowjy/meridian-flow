/** The read agent's refusal names its own scratch when the refused file is another Work's. */

import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import type { DocumentId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import type { FileFacts } from "../domains/file-policy/index.js";
import { type PermissionDenial, permissionDeniedMessage } from "./file-access-denial-copy.js";

function readOnly(scheme: ContextUriScheme): PermissionDenial {
  return {
    denied: true,
    target: { kind: "document", documentId: "doc" as DocumentId },
    reason: "agent_read_only",
    level: "read",
    archivedWork: null,
    facts: { scheme } as FileFacts,
    destination: { kind: "live" },
    agentChain: [],
  };
}

describe("agent_read_only copy", () => {
  it("states the read permission for a non-scratch file", () => {
    expect(permissionDeniedMessage(readOnly("manuscript"))).toBe(
      "Your permission is read, so you can change only scratch://.",
    );
  });

  it("says only this chat's scratch when the file is another Work's scratch", () => {
    expect(permissionDeniedMessage(readOnly("scratch"))).toBe(
      "Your permission is read, so you can change only this chat's scratch://, not another Work's.",
    );
  });
});
