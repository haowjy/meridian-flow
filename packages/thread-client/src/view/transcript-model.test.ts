/** Response grouping across a write-mode divider.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Write-mode dividers split response groups
 */
import type { Turn } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { buildTranscriptModel } from "./transcript-model";

function turn(id: string, role: Turn["role"], extra: Partial<Turn> = {}): Turn {
  return {
    id,
    threadId: "t",
    position: 0,
    role,
    status: "complete",
    blocks: [],
    metadata: null,
    ...extra,
  } as unknown as Turn;
}

it("never groups a reply across a write-mode divider, even after a steer", () => {
  const turns = [
    turn("a", "assistant"),
    // Sent before the switch was queued, so the server stamped it a steer.
    turn("m", "user", { metadata: { delivery: "steer" } }),
    turn("sw", "system", { metadata: { kind: "write_mode_switch", mode: "direct" } }),
    turn("b", "assistant"),
  ];
  const model = buildTranscriptModel(turns, false);
  expect(model.rows.map((row) => row.kind)).toEqual(["turn", "turn", "write-mode", "turn"]);
  expect(model.continuing).toEqual([false, false, false, false]);
  expect(model.partsByFinalTurnId.get("a")?.map((part) => part.id)).toEqual(["a"]);
  expect(model.partsByFinalTurnId.get("b")?.map((part) => part.id)).toEqual(["b"]);
});

it("reports cached malformed subagent claims on every build", () => {
  const malformedUpdate = turn("notice", "system", {
    metadata: { kind: "subagent_update", childThreadId: 42 },
  });
  const malformedCard = turn("reply", "assistant", {
    blocks: [
      {
        id: "bad-card",
        turnId: "reply",
        responseId: null,
        blockType: "custom",
        sequence: 0,
        content: { kind: "helper-result", props: { agentName: 42 } },
        createdAt: "2026-10-23T00:00:00.000Z",
      },
    ],
  });
  const failures: unknown[] = [];
  const build = () =>
    buildTranscriptModel([malformedCard, malformedUpdate], false, null, (failure) =>
      failures.push(failure),
    );

  build();
  build();
  expect(failures).toEqual([
    { contract: "invocation_card", turnId: "reply", blockId: "bad-card" },
    { contract: "subagent_update", turnId: "notice" },
    { contract: "invocation_card", turnId: "reply", blockId: "bad-card" },
    { contract: "subagent_update", turnId: "notice" },
  ]);
});
