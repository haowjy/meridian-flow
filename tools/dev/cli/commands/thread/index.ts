/** `thread`: read, drive, and follow thread sessions. */
import type { CommandGroup } from "../../core/command";
import { threadCancelCommand } from "./cancel";
import { threadContextCommand } from "./context";
import { threadCreateCommand } from "./create";
import { threadEventsCommand } from "./events";
import { threadListCommand } from "./list";
import { threadRespondCommand } from "./respond";
import { threadSendCommand } from "./send";
import { threadTailCommand } from "./tail";
import { threadViewCommand } from "./view";

export const threadGroup: CommandGroup = {
  name: "thread",
  summary: "Read, drive, and follow thread sessions",
  commands: [
    threadListCommand,
    threadViewCommand,
    threadContextCommand,
    threadEventsCommand,
    threadCreateCommand,
    threadSendCommand,
    threadTailCommand,
    threadCancelCommand,
    threadRespondCommand,
  ],
};
