/** Record the notice for a committed thread Work transition. */
import type { RebindThreadWorkResult } from "@meridian/contracts/works";
import { createWriterWorkSwitchedNotice, type NoticePort } from "../domains/notices/index.js";

export async function recordWorkSwitchNotice(
  notices: Pick<NoticePort, "record">,
  transition: RebindThreadWorkResult,
  previousScratchUri?: string,
): Promise<void> {
  if (!transition.changed) return;
  await notices.record(
    createWriterWorkSwitchedNotice({
      threadId: transition.threadId,
      previousWorkId: transition.before.workId,
      previousWorkName: transition.before.name,
      workId: transition.after.workId,
      workName: transition.after.name,
      previousScratchUri,
    }),
  );
}
