import { describe, expect, it } from "vitest";
import { mapSessionStatusToConnectionState } from "@/features/documents/stores/useCollabStore";

describe("document collab connection state mapping", () => {
  it("maps connected/disconnected directly", () => {
    expect(mapSessionStatusToConnectionState("connected")).toBe("connected");
    expect(mapSessionStatusToConnectionState("disconnected")).toBe(
      "disconnected",
    );
  });

  it("maps transitional session states to syncing", () => {
    expect(mapSessionStatusToConnectionState("connecting")).toBe("syncing");
    expect(mapSessionStatusToConnectionState("authenticating")).toBe(
      "syncing",
    );
    expect(mapSessionStatusToConnectionState("syncing")).toBe("syncing");
  });
});
