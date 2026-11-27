import { t } from "@lingui/core/macro";
import {
  type CommandDriver,
  type CommandRecord,
  JournalUnavailableError,
  type SubmitInput,
} from "@meridian/command-driver";
import { notifyFailure } from "@/components/app/failure-toast";

export class DeviceRefusedError extends Error {
  readonly name = "DeviceRefusedError";
  constructor() {
    super("The change could not be saved on this device");
  }
}

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
      title: t`Couldn't save`,
      reason:
        cause.cause instanceof DOMException && cause.cause.name === "QuotaExceededError"
          ? t`Storage full`
          : undefined,
      detail: cause,
    });
    return null;
  }
}

export async function settleCommand(
  driver: CommandDriver | null,
  input: SubmitInput,
): Promise<CommandRecord | null> {
  if (!driver) throw new Error("Commands are not available yet");
  const record = await submitCommand(driver, input);
  if (!record) throw new DeviceRefusedError();
  const settled = await driver.whenSettled(record.id);
  if (settled?.state !== "never") return settled?.state === "done" ? settled : null;
  void driver.dismiss(record.id);
  throw new Error(`${input.kind} ended never`);
}
