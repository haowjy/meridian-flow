import { readRunState, type ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import type { HandBackResult } from "@meridian/contracts/threads";
import { INITIAL_RUN_STATE_VIEW, type RunStateView, receiveRecord } from "@meridian/thread-client";
import { CliError } from "../../core/cli-error";

export function viewOfSnapshot(snapshot: ThreadSnapshotResponse): RunStateView {
  const record = readRunState(snapshot.liveState?.runState);
  if (!record)
    throw new CliError(
      "protocol",
      "the snapshot carries no readable run-state record, so nothing can be claimed about the queue",
    );
  return receiveRecord(INITIAL_RUN_STATE_VIEW, record);
}

export function handedBackText(summary: string, handedBack: HandBackResult["handedBack"]): string {
  const texts = handedBack.map((message) =>
    message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
  );
  return [summary, ...texts].join("\n\n");
}
