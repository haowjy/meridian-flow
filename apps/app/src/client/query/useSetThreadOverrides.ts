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

export function useThreadOverrides(threadId: string, server: ThreadOverrides): ThreadOverrides {
  const records = useCommands();
  return useMemo(
    () => projectThreadOverrides(records, threadId, server),
    [records, threadId, server],
  );
}

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
