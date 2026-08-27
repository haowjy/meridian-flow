/** Writer-adapter policy for recording a committed thread Work transition. */
import type { RebindThreadWorkResult } from "@meridian/contracts/works";
import { createWriterWorkSwitchedNotice, type NoticePort } from "../domains/notices/index.js";

export async function recordWriterWorkSwitchNotice(
  notices: Pick<NoticePort, "record">,
  transition: RebindThreadWorkResult,
): Promise<void> {
  if (!transition.changed) return;
  const previousWorkName = transition.receipt.before?.name;
  if (!previousWorkName) throw new Error("Work switch receipt is missing its previous name");
  await notices.record(
    createWriterWorkSwitchedNotice({
      threadId: transition.threadId,
      previousWorkId: transition.previousWorkId,
      previousWorkName,
      workId: transition.work.id,
      workName: transition.work.name,
    }),
  );
}
