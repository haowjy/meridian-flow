/** Shared reading and printing for the commands that drive the chat queue (`stop`, `queue ...`). */
import type { ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import type { HandBackResult } from "@meridian/contracts/threads";
import { INITIAL_RUN_STATE_VIEW, type RunStateView, receiveRecord } from "@meridian/thread-client";

/** The view over a snapshot's run-state record: what the app would have drawn from it. */
export const viewOfSnapshot = (snapshot: ThreadSnapshotResponse): RunStateView =>
  receiveRecord(INITIAL_RUN_STATE_VIEW, snapshot.liveState.runState);

/** The summary, then each handed-back message's text in send order with blank lines between. */
export function handedBackText(summary: string, handedBack: HandBackResult["handedBack"]): string {
  const texts = handedBack.map((message) =>
    message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
  );
  return [summary, ...texts].join("\n\n");
}
