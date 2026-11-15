/** useSetThreadModel — set or clear the model a chat runs on, as a command that survives reloads. */
import { useCallback } from "react";

import { useCommandDriver } from "@/client/commands/driver-context";
import { submitCommand } from "@/client/commands/submit";
import {
  THREAD_SET_MODEL_KIND,
  type ThreadSetModelBody,
  threadModelLane,
} from "./thread-model-command";

/** `model: null` clears the override. The change shows at once through `projectThreadModel`. */
export function useSetThreadModel(threadId: string): (model: string | null) => void {
  const driver = useCommandDriver();
  return useCallback(
    (model) => {
      if (!driver) return;
      const body: ThreadSetModelBody = { threadId, model };
      void submitCommand(driver, {
        kind: THREAD_SET_MODEL_KIND,
        lanes: [threadModelLane(threadId)],
        body,
      });
    },
    [driver, threadId],
  );
}
