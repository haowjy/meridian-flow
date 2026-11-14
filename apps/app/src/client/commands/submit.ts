import { t } from "@lingui/core/macro";
import {
  type CommandDriver,
  type CommandRecord,
  JournalUnavailableError,
  type SubmitInput,
} from "@meridian/command-driver";
import { notifyFailure } from "@/components/app/failure-toast";

/**
 * Saves a command in the journal. The one place a device that cannot keep it is told to the
 * writer: nothing was saved, shown or sent, so the caller gets `null` and does nothing more.
 */
export async function submitCommand(
  driver: CommandDriver,
  input: SubmitInput,
): Promise<CommandRecord | null> {
  try {
    return await driver.submit(input);
  } catch (cause) {
    if (!(cause instanceof JournalUnavailableError)) throw cause;
    notifyFailure({
      key: "command-journal",
      title: t`Couldn’t save that change on this device, so it wasn’t sent.`,
    });
    return null;
  }
}
