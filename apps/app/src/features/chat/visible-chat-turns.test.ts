import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { isVisibleChatTurn } from "./visible-chat-turns";

describe("isVisibleChatTurn", () => {
  it("hides Work-context system updates carried as user-role plumbing", () => {
    expect(
      isVisibleChatTurn({
        role: "user",
        metadata: { kind: "system_update", section: "work_context" },
        blocks: [],
      } as unknown as Turn),
    ).toBe(false);
  });

  it("keeps ordinary writer turns visible", () => {
    expect(isVisibleChatTurn({ role: "user", metadata: null, blocks: [] } as unknown as Turn)).toBe(
      true,
    );
  });
});
