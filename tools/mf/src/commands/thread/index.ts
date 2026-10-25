/** `thread`: read, drive, and follow thread sessions. */
import type { CommandGroup } from "../../core/command";
import { threadCancelCommand } from "./cancel";
import { threadContextCommand } from "./context";
import { threadCreateCommand } from "./create";
import { threadEventsCommand } from "./events";
import { threadListCommand } from "./list";
import { threadQueueHandBackCommand, threadQueueSendNowCommand } from "./queue";
import { threadSendCommand } from "./send";
import { threadStopCommand } from "./stop";
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
    threadStopCommand,
    threadQueueHandBackCommand,
    threadQueueSendNowCommand,
    threadCancelCommand,
  ],
};
