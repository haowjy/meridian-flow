/** What the writer sees while a write-mode switch goes from asked to queued to applied. */
import type { PendingInboxItem, ThreadPendingInbox } from "@meridian/contracts/threads";
import { expect, it } from "vitest";
import {
  controlsReducer,
  type JournaledSwitch,
  mergeQueuedControls,
  NO_LOCAL_CONTROLS,
  overlaidWriteMode,
  switchesCancelledBy,
} from "./thread-controls";

const EMPTY: ThreadPendingInbox = { items: [] };
const NONE: ReadonlySet<string> = new Set();
const switchTo = (id: string, mode: "draft" | "direct", failed = false): JournaledSwitch => ({
  id,
  mode,
  failed,
});
const serverRow = (id: string, mode: "draft" | "direct"): PendingInboxItem =>
  ({
    id,
    seq: 1,
    intent: "control",
    control: { kind: "write_mode", mode },
    provenance: { kind: "writer", actorId: "w" },
    deliveryState: "waiting",
    summary: "",
    enqueuedAt: "2026-10-11T00:00:00.000Z",
  }) as PendingInboxItem;

it("goes from sending to queued to nothing once the divider answers it", () => {
  const sending = mergeQueuedControls({
    local: NO_LOCAL_CONTROLS,
    pending: EMPTY,
    journaled: [switchTo("s1", "direct")],
    executedControlIds: NONE,
  });
  expect(sending.map((row) => row.status)).toEqual(["sending"]);
  // The driver got the server's answer: queued behind a reply, the inbox not yet echoing.
  const answered = controlsReducer(NO_LOCAL_CONTROLS, {
    type: "switch_answered",
    id: "s1",
    control: { kind: "write_mode", mode: "direct" },
    pending: serverRow("s1", "direct"),
    turnId: null,
    cancels: [],
  });
  const queued = mergeQueuedControls({
    local: answered,
    pending: EMPTY,
    executedControlIds: NONE,
  });
  expect(queued.map((row) => row.status)).toEqual(["queued"]);
  expect(overlaidWriteMode("draft", queued)).toBe("direct");
  // Its divider arrives: the row is the divider now.
  expect(
    mergeQueuedControls({ local: answered, pending: EMPTY, executedControlIds: new Set(["s1"]) }),
  ).toEqual([]);
});

it("hides both rows of a switch back at once, and the server's null answer confirms it", () => {
  const input = {
    local: NO_LOCAL_CONTROLS,
    pending: { items: [serverRow("s1", "direct")] },
    journaled: [switchTo("s2", "draft")],
    executedControlIds: NONE,
  };
  expect(mergeQueuedControls(input)).toEqual([]);
  expect(overlaidWriteMode("draft", mergeQueuedControls(input))).toBe("draft");
  const cancels = switchesCancelledBy(input, { id: "s2", mode: "draft" });
  expect(cancels).toEqual(["s1"]);
  // The answer: both stay hidden even while a stale inbox frame still lists the first.
  const local = controlsReducer(NO_LOCAL_CONTROLS, {
    type: "switch_answered",
    id: "s2",
    control: { kind: "write_mode", mode: "draft" },
    pending: null,
    turnId: null,
    cancels,
  });
  expect(mergeQueuedControls({ local, pending: input.pending, executedControlIds: NONE })).toEqual(
    [],
  );
  // A switch back that failed to reach the server cancels nothing.
  const failed = mergeQueuedControls({ ...input, journaled: [switchTo("s2", "draft", true)] });
  expect(failed.map((row) => [row.id, row.status])).toEqual([
    ["s1", "queued"],
    ["s2", "failed"],
  ]);
  expect(overlaidWriteMode("draft", failed)).toBe("direct");
});
