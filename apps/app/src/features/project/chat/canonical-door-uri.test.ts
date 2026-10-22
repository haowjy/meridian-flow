import { describe, expect, it } from "vitest";
import { canonicalDoorUri } from "./canonical-door-uri";

describe("a chat door's catalog address", () => {
  it("spells a lineage's Scratch with the chat's handle, however the door was written", () => {
    expect(
      canonicalDoorUri(
        { scheme: "scratch", path: "/duel/beats.md", workId: null, rootThreadId: "root" },
        { ownerRef: "c2" },
      ),
    ).toBe("scratch://@c2/duel/beats.md");
  });

  it("spells a named Work's Scratch with its handle, not left bare", () => {
    expect(
      canonicalDoorUri(
        { scheme: "scratch", path: "/beats.md", workId: "arc" },
        { workHandle: "w1" },
      ),
    ).toBe("scratch://@w1/beats.md");
  });

  it("spells a chat's Uploads with its handle and leaves project areas plain", () => {
    expect(
      canonicalDoorUri(
        { scheme: "uploads", path: "/map.png", workId: null, chatId: "chat-id" },
        { ownerRef: "c15" },
      ),
    ).toBe("uploads://@c15/map.png");
    expect(canonicalDoorUri({ scheme: "manuscript", path: "/ch.md", workId: null }, {})).toBe(
      "manuscript://ch.md",
    );
  });

  it("gives up, so the caller keeps the written address, while a handle is unknown", () => {
    expect(canonicalDoorUri({ scheme: "scratch", path: "/x.md", workId: "arc" }, {})).toBeNull();
  });
});
