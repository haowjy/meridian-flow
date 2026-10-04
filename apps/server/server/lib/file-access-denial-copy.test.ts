/** The read agent's refusal names its own scratch when the refused file is another Work's. */

import type { DocumentId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { type PermissionDenial, permissionDeniedMessage } from "./file-access-denial-copy.js";

function readOnly(scheme: PermissionDenial["scheme"]): PermissionDenial {
  return {
    denied: true,
    target: { kind: "document", documentId: "doc" as DocumentId },
    need: "edit",
    reason: "agent_read_only",
    limitedBy: "agent_read_only",
    level: "read",
    archivedWork: null,
    scheme,
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
