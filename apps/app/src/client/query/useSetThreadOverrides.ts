/** The model and reasoning a chat runs its Agent at, and setting or clearing them as a command that survives reloads. */
import type { ThreadOverrides } from "@meridian/contracts/threads";
import { useCallback, useMemo } from "react";

import { useCommandDriver, useCommands } from "@/client/commands/driver-context";
import { submitCommand } from "@/client/commands/submit";
import {
  projectThreadOverrides,
  THREAD_SET_OVERRIDES_KIND,
  type ThreadSetOverridesBody,
  threadOverridesLane,
} from "./thread-overrides-command";

/** The chat's overrides as the writer last set them, before the server has them, else the server's. */
export function useThreadOverrides(threadId: string, server: ThreadOverrides): ThreadOverrides {
  const records = useCommands();
  return useMemo(
    () => projectThreadOverrides(records, threadId, server),
    [records, threadId, server],
  );
}

/** A `null` part clears it. The change shows at once through `useThreadOverrides`. */
export function useSetThreadOverrides(threadId: string): (overrides: ThreadOverrides) => void {
  const driver = useCommandDriver();
  return useCallback(
    (overrides) => {
      if (!driver) return;
      const body: ThreadSetOverridesBody = { threadId, overrides };
      void submitCommand(driver, {
        kind: THREAD_SET_OVERRIDES_KIND,
        lanes: [threadOverridesLane(threadId)],
        body,
      });
    },
    [driver, threadId],
  );
}
